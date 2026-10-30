import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FactoryClient } from "./client";
import { prepareWorkset } from "./prepare";

let root: string;
let companion: string;
const ENV = { MATE_FACTORY_REPOSITORIES: "git://127.0.0.1/acme/web.git" };

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-prepare-")));
  companion = path.join(root, "acme-companion");
  fs.mkdirSync(path.join(companion, "worksets"), { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function record(id: string, body: string): void {
  fs.writeFileSync(path.join(companion, "worksets", `${id}.yaml`), `id: ${id}\n${body}`);
}

function fakeClient(linkStatus = 0) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    spawn: async (request: unknown) => {
      calls.push(["spawn", request]);
      return {};
    },
    exec: async (request: { command: string[] }) => {
      calls.push(["exec", request.command]);
      return { status: linkStatus, stdout: "", stderr: linkStatus ? "acme link broke" : "" };
    },
  } as unknown as FactoryClient;
  return { client, calls };
}

describe("preparing a Workset's container", () => {
  test("a Workset at Ready that never had a session is spawned and linked", async () => {
    record("acme-greet", "title: Greet\nstage: ready\nrepositories: [acme/web]\n");
    const { client, calls } = fakeClient();
    const prepared = await prepareWorkset(client, companion, "acme-greet", ENV);
    expect(prepared.id).toBe("acme-greet");
    expect(calls).toEqual([
      [
        "spawn",
        {
          id: "acme-greet",
          repository: "acme/web",
          remoteUrl: "git://127.0.0.1/acme/web.git",
          companion,
        },
      ],
      ["exec", ["mate", "working", "link", "--companion", companion, "--yes"]],
    ]);
  });

  test("an unknown repository spawns nothing", async () => {
    record("acme-greet", "repositories: [acme/other]\n");
    const { client, calls } = fakeClient();
    await expect(prepareWorkset(client, companion, "acme-greet", ENV)).rejects.toThrow(
      "acme/other is neither linked here nor a configured factory repository",
    );
    expect(calls).toEqual([]);
  });

  test("a failed link is reported", async () => {
    record("acme-greet", "repositories: [acme/web]\n");
    const { client } = fakeClient(1);
    await expect(prepareWorkset(client, companion, "acme-greet", ENV)).rejects.toThrow(
      "linking the worktree failed: acme link broke",
    );
  });
});
