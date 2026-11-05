import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureOpenCodeServer, serverStamp, type ServerDeps } from "./opencode-server";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-server-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface FakeServer {
  password: string;
  active: string[];
}

function fakeDeps(overrides: Partial<ServerDeps> = {}) {
  const servers = new Map<string, FakeServer>();
  const alive = new Set<number>();
  const started: { port: number; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  const killed: [number, NodeJS.Signals][] = [];
  let nextPid = 100;
  let nextPort = 4100;
  const deps: ServerDeps = {
    dir,
    start: ({ cwd, env, port }) => {
      const pid = nextPid++;
      alive.add(pid);
      servers.set(`http://127.0.0.1:${port}`, {
        password: env.OPENCODE_SERVER_PASSWORD!,
        active: [],
      });
      started.push({ port, env, cwd });
      return pid;
    },
    freePort: async () => nextPort++,
    fetch: async (url, init) => {
      const server = servers.get(new URL(url).origin);
      if (!server) throw new Error("connection refused");
      const auth = (init?.headers as Record<string, string>).authorization;
      const expected = `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`;
      if (auth !== expected) return new Response("{}", { status: 401 });
      const data = Object.fromEntries(server.active.map((id) => [id, { type: "running" }]));
      return Response.json({ data });
    },
    alive: (pid) => alive.has(pid),
    command: () => "opencode serve --hostname 127.0.0.1 --port 4100",
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      alive.delete(pid);
    },
    sleep: async () => {},
    now: () => new Date("2026-11-05T10:00:00Z"),
    password: () => `pw-${nextPid}`,
    ...overrides,
  };
  return { deps, servers, alive, started, killed };
}

const input = (env: NodeJS.ProcessEnv = { MATE_GUIDANCE_JSON: "{}" }) => ({
  repositoryId: "acme/app",
  cwd: "/tmp/app",
  env,
  version: "2.1.4",
});

function readRecord() {
  return JSON.parse(fs.readFileSync(path.join(dir, "acme_app.json"), "utf8"));
}

describe("ensureOpenCodeServer", () => {
  test("starts a server with the flag and password in its env only", async () => {
    const fake = fakeDeps();
    const server = await ensureOpenCodeServer(input(), fake.deps);

    expect(server.url).toBe("http://127.0.0.1:4100");
    expect(fake.started[0]?.env.MATE_OPENCODE_SERVER).toBe("1");
    expect(fake.started[0]?.env.OPENCODE_SERVER_PASSWORD).toBe(server.password);
    expect(fake.started[0]?.cwd).toBe("/tmp/app");

    const record = readRecord();
    expect(record).toMatchObject({ url: server.url, pid: 100, version: "2.1.4" });
    expect(JSON.stringify(record)).not.toContain(server.password);
    const key = path.join(dir, "acme_app.key");
    expect(fs.readFileSync(key, "utf8").trim()).toBe(server.password);
    expect(fs.statSync(key).mode & 0o777).toBe(0o600);
  });

  test("reuses a running server with the same stamp", async () => {
    const fake = fakeDeps();
    const first = await ensureOpenCodeServer(input(), fake.deps);
    const second = await ensureOpenCodeServer(input(), fake.deps);
    expect(second).toEqual(first);
    expect(fake.started).toHaveLength(1);
  });

  test("replaces a server whose process is gone", async () => {
    const fake = fakeDeps();
    await ensureOpenCodeServer(input(), fake.deps);
    fake.alive.clear();
    const server = await ensureOpenCodeServer(input(), fake.deps);
    expect(fake.started).toHaveLength(2);
    expect(readRecord()).toMatchObject({ url: server.url, pid: 101 });
  });

  test("restarts an idle server with an older configuration", async () => {
    const fake = fakeDeps();
    await ensureOpenCodeServer(input(), fake.deps);
    const server = await ensureOpenCodeServer(input({ MATE_GUIDANCE_JSON: "{1}" }), fake.deps);
    expect(fake.killed).toEqual([[100, "SIGTERM"]]);
    expect(server.warning).toBeUndefined();
    expect(readRecord().pid).toBe(101);
  });

  test("reuses a busy server with an older configuration and warns", async () => {
    const fake = fakeDeps();
    const first = await ensureOpenCodeServer(input(), fake.deps);
    fake.servers.get(first.url)!.active.push("ses_1");
    const server = await ensureOpenCodeServer(input({ MATE_GUIDANCE_JSON: "{1}" }), fake.deps);
    expect(server.url).toBe(first.url);
    expect(server.warning).toContain("older configuration");
    expect(fake.killed).toEqual([]);
  });

  test("stops a server that no longer answers before starting the next", async () => {
    const fake = fakeDeps();
    const first = await ensureOpenCodeServer(input(), fake.deps);
    fake.servers.delete(first.url);
    await ensureOpenCodeServer(input(), fake.deps);
    expect(fake.killed).toEqual([[100, "SIGTERM"]]);
    expect(readRecord().pid).toBe(101);
  });

  test("leaves a reused pid alone when the recorded server is gone", async () => {
    const fake = fakeDeps({ command: () => "/usr/bin/vim notes.txt" });
    const first = await ensureOpenCodeServer(input(), fake.deps);
    fake.servers.delete(first.url);
    await ensureOpenCodeServer(input(), fake.deps);
    expect(fake.killed).toEqual([]);
    expect(fake.started).toHaveLength(2);
  });

  test("fails with the log path when the server never answers, after one retry", async () => {
    const fake = fakeDeps();
    const silent = fakeDeps({ fetch: async () => new Response("{}", { status: 503 }) });
    silent.deps.start = fake.deps.start;
    silent.deps.alive = fake.deps.alive;
    silent.deps.kill = fake.deps.kill;
    await expect(ensureOpenCodeServer(input(), silent.deps)).rejects.toThrow(
      path.join(dir, "acme_app.log"),
    );
    expect(fake.started).toHaveLength(2);
    expect(fake.killed.map(([pid]) => pid)).toEqual([100, 101]);
    expect(fs.existsSync(path.join(dir, "acme_app.key"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "acme_app.json"))).toBe(false);
  });
});

describe("readiness timeout", () => {
  test("a server that hangs on every check gives up by the clock", async () => {
    const fake = fakeDeps();
    let clock = Date.parse("2026-11-05T10:00:00Z");
    let checks = 0;
    const hanging = fakeDeps({
      fetch: async () => {
        checks += 1;
        clock += 2000;
        throw new Error("timed out");
      },
    });
    hanging.deps.start = fake.deps.start;
    hanging.deps.alive = fake.deps.alive;
    hanging.deps.kill = fake.deps.kill;
    hanging.deps.now = () => new Date(clock);
    hanging.deps.sleep = async (ms) => {
      clock += ms;
    };
    await expect(ensureOpenCodeServer(input(), hanging.deps)).rejects.toThrow("did not start");
    // 15 s per attempt at 2.2 s per check, two attempts.
    expect(checks).toBeLessThanOrEqual(2 * 7);
  });
});

describe("serverStamp", () => {
  test("covers Mate variables only, in any order", () => {
    const a = serverStamp({ MATE_A: "1", MATE_B: "2", HOME: "/x" });
    expect(serverStamp({ MATE_B: "2", MATE_A: "1", HOME: "/y" })).toBe(a);
    expect(serverStamp({ MATE_A: "1", MATE_B: "3" })).not.toBe(a);
    expect(serverStamp({ MATE_A: "1", MATE_B: "2", MATE_OPENCODE_SERVER: "1" })).toBe(a);
  });
});
