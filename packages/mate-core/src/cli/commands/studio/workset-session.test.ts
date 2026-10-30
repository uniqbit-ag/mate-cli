import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import type { FactoryClient } from "../../../lib/factory/client";
import { createWorksetResolver } from "./workset-session";

let root: string;
let companion: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-workset-session-")));
  companion = path.join(root, "acme-companion");
  fs.mkdirSync(path.join(companion, "worksets"), { recursive: true });
  fs.mkdirSync(path.join(companion, ".mate", "config"), { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function record(id: string, body: string): void {
  fs.writeFileSync(path.join(companion, "worksets", `${id}.yaml`), `id: ${id}\n${body}`);
}

function fakeClient(
  options: { credential?: string | null; conversation?: boolean; linkFails?: boolean } = {},
) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    info: async () => ({
      credential: options.credential === undefined ? "CLAUDE_CODE_OAUTH_TOKEN" : options.credential,
    }),
    spawn: async (request: unknown) => {
      calls.push(["spawn", request]);
      return {};
    },
    exec: async (request: { command: string[] }) => {
      calls.push(["exec", request.command]);
      if (request.command[1] === "working") {
        return options.linkFails
          ? { status: 1, stdout: "", stderr: "acme link broke" }
          : { status: 0, stdout: "", stderr: "" };
      }
      return { status: options.conversation ? 0 : 1, stdout: "", stderr: "" };
    },
  } as unknown as FactoryClient;
  return { client, calls };
}

function resolver(client: FactoryClient | null) {
  return createWorksetResolver({
    collectInventory: async () => ({
      companions: [{ path: companion, health: "ready", pairings: [] }],
    }),
    launchCompanion: companion,
    mateCommand: ["bun", "cli.mjs"],
    client: () => client,
    env: { MATE_FACTORY_REPOSITORIES: "https://git.acme.test/acme/web.git" },
    now: () => new Date("2026-10-29T12:00:00.000Z"),
  });
}

const SESSION = "acme-session-0001";

describe("resolving a Workset session", () => {
  test("outside factory mode nothing starts", async () => {
    expect(await resolver(null)("acme-login", null, SESSION)).toEqual({
      reason: "Workset sessions need the appliance's factory mode",
    });
  });

  test("without a credential nothing is spawned", async () => {
    record("acme-login", "repositories: [acme/web]\n");
    const { client, calls } = fakeClient({ credential: null });
    const result = await resolver(client)("acme-login", null, SESSION);
    expect("reason" in result && result.reason).toContain("no Workset agent credential");
    expect(calls).toEqual([]);
  });

  test.each([
    [
      "an unknown Workset",
      "acme-other",
      "repositories: [acme/web]\n",
      /no valid Workset acme-other/,
    ],
    [
      "two repositories",
      "acme-login",
      "repositories: [acme/web, acme/api]\n",
      /names 2 repositories/,
    ],
    [
      "an unresolvable repository",
      "acme-login",
      "repositories: [acme/unknown]\n",
      /acme\/unknown is neither linked/,
    ],
  ])("refuses %s before spawning", async (_name, id, body, reason) => {
    record("acme-login", body);
    const { client, calls } = fakeClient();
    const result = await resolver(client)(id, null, SESSION);
    expect("reason" in result && result.reason).toMatch(reason);
    expect(calls).toEqual([]);
  });

  test("the first session spawns from the configured URL, links, and starts Clarify intent", async () => {
    record("acme-login", "title: Login with SSO\nrepositories: [acme/web]\n");
    const { client, calls } = fakeClient();
    const result = await resolver(client)("acme-login", null, SESSION);
    expect(calls[0]).toEqual([
      "spawn",
      {
        id: "acme-login",
        repository: "acme/web",
        remoteUrl: "https://git.acme.test/acme/web.git",
        companion,
      },
    ]);
    expect(calls[1]).toEqual([
      "exec",
      ["mate", "working", "link", "--companion", companion, "--yes"],
    ]);
    expect(result).toEqual({
      companionPath: companion,
      workset: { id: "acme-login", title: "Login with SSO" },
      argv: [
        "bun",
        "cli.mjs",
        "factory",
        "attach",
        "acme-login",
        "--session",
        SESSION,
        "--start",
        "clarify",
        "--companion",
        companion,
      ],
    });
  });

  test("a later session continues the conversation", async () => {
    record("acme-login", "repositories: [acme/web]\n");
    const result = await resolver(fakeClient({ conversation: true }).client)(
      "acme-login",
      null,
      SESSION,
    );
    expect("argv" in result && result.argv).toContain("continue");
  });

  test("Explore change starts once and records it, then continues", async () => {
    record("acme-login", "repositories: [acme/web]\nstage: explore\n");
    const { client } = fakeClient({ conversation: true });
    const first = await resolver(client)("acme-login", null, SESSION);
    expect("argv" in first && first.argv).toContain("explore");
    const saved = parse(
      fs.readFileSync(path.join(companion, "worksets", "acme-login.yaml"), "utf8"),
    );
    expect(saved.exploreStartedAt).toBe("2026-10-29T12:00:00.000Z");
    const second = await resolver(client)("acme-login", null, SESSION);
    expect("argv" in second && second.argv).toContain("continue");
  });

  test("a failed link is shown and nothing is started", async () => {
    record("acme-login", "repositories: [acme/web]\n");
    const result = await resolver(fakeClient({ linkFails: true }).client)(
      "acme-login",
      null,
      SESSION,
    );
    expect(result).toEqual({ reason: "linking the worktree failed: acme link broke" });
  });
});
