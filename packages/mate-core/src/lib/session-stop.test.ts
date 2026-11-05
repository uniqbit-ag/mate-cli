import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { addSession, readSessionRegistry } from "../runtime/session-registry";
import { stopSession, type SessionStopDeps } from "./session-stop";

let home: string;
let file: string;
let servers: string;
let work: string;

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acme-session-stop-")));
  file = path.join(home, "sessions.json");
  servers = path.join(home, "opencode-servers");
  work = path.join(home, "acme");
  await fs.mkdir(work);
  await fs.mkdir(servers);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function writeServer() {
  const base = path.join(servers, "acme_app");
  const record = { url: "http://127.0.0.1:4100", pid: 9, stamp: "s", startedAt: "x" };
  await fs.writeFile(`${base}.json`, JSON.stringify(record));
  await fs.writeFile(`${base}.key`, "secret\n");
}

function deps(overrides: SessionStopDeps = {}) {
  const requests: Array<{ url: string; auth: string | undefined }> = [];
  const value: SessionStopDeps = {
    file,
    serversDir: servers,
    repositoryIdOf: () => "acme/app",
    alive: () => true,
    fetch: async (url, init) => {
      requests.push({ url, auth: (init?.headers as Record<string, string>).authorization });
      return Response.json({ interrupted: true });
    },
    ...overrides,
  };
  return { value, requests };
}

describe("stopSession", () => {
  test("interrupts through the repository's server and ends the session", async () => {
    await addSession({ id: "ses_1", runtime: "opencode", cwd: work, pid: 9 }, { file });
    await writeServer();
    const { value, requests } = deps();

    const stopped = await stopSession("ses_1", value);

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:4100/api/session/ses_1/interrupt",
        auth: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
      },
    ]);
    expect(stopped.endedAt).toBeDefined();
    expect((await readSessionRegistry(file)).sessions[0]?.endedAt).toBe(stopped.endedAt);
  });

  test("a session the server does not know is still ended", async () => {
    await addSession({ id: "ses_1", runtime: "opencode", cwd: work }, { file });
    await writeServer();
    const { value } = deps({ fetch: async () => new Response("{}", { status: 404 }) });
    expect((await stopSession("ses_1", value)).endedAt).toBeDefined();
  });

  test("refuses unknown, non-OpenCode, and serverless sessions", async () => {
    await addSession({ id: "c1", runtime: "claude", cwd: work }, { file });
    await addSession({ id: "ses_1", runtime: "opencode", cwd: work }, { file });
    const { value } = deps();

    await expect(stopSession("nope", value)).rejects.toThrow("not registered");
    await expect(stopSession("c1", value)).rejects.toThrow("not an OpenCode session");
    await expect(stopSession("ses_1", value)).rejects.toThrow("no Mate OpenCode server");

    await writeServer();
    await expect(stopSession("ses_1", { ...value, alive: () => false })).rejects.toThrow(
      "no Mate OpenCode server",
    );
    await expect(stopSession("ses_1", { ...value, repositoryIdOf: () => null })).rejects.toThrow(
      "no Mate OpenCode server",
    );
    await addSession({ id: "ses_2", runtime: "opencode", cwd: work, pid: 5 }, { file });
    await expect(stopSession("ses_2", value)).rejects.toThrow("does not run in the Mate");
    expect((await readSessionRegistry(file)).sessions.every((s) => !s.endedAt)).toBe(true);
  });

  test("a server that does not answer leaves the session running", async () => {
    await addSession({ id: "ses_1", runtime: "opencode", cwd: work }, { file });
    await writeServer();
    const { value } = deps({
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    await expect(stopSession("ses_1", value)).rejects.toThrow("did not stop session ses_1");
    expect((await readSessionRegistry(file)).sessions[0]?.endedAt).toBeUndefined();
  });
});
