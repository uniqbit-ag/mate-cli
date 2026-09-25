import { describe, expect, test } from "bun:test";

import {
  bunTerminalSpawn,
  RingBuffer,
  TerminalRegistry,
  terminalUnsupportedReason,
  type TerminalProcess,
  type TerminalRegistryOptions,
  type TerminalSpawnRequest,
  type TerminalViewer,
} from "./terminal";
import { createLaunchResolver } from "./terminal-launch";

const ACME = "/companions/acme";

interface FakeProcess extends TerminalProcess {
  request: TerminalSpawnRequest;
  written: string[];
  sizes: [number, number][];
  exit(status: number): void;
  emit(text: string): void;
}

function fakeSpawn() {
  const spawned: FakeProcess[] = [];
  const spawn = (request: TerminalSpawnRequest): TerminalProcess => {
    let resolveExit!: (status: number) => void;
    const exited = new Promise<number>((resolve) => (resolveExit = resolve));
    const proc: FakeProcess = {
      pid: 90_000 + spawned.length,
      exited,
      request,
      written: [],
      sizes: [],
      write: (data) => void proc.written.push(data),
      resize: (cols, rows) => void proc.sizes.push([cols, rows]),
      close: () => {},
      exit: (status) => resolveExit(status),
      emit: (text) => request.onData(new TextEncoder().encode(text)),
    };
    spawned.push(proc);
    return proc;
  };
  return { spawned, spawn };
}

interface FakeViewer extends TerminalViewer {
  messages: Record<string, unknown>[];
  output: string;
  closedWith: number | null;
  buffered: number;
}

function viewer(): FakeViewer {
  const v: FakeViewer = {
    messages: [],
    output: "",
    closedWith: null,
    buffered: 0,
    send(data) {
      if (typeof data === "string") v.messages.push(JSON.parse(data));
      else v.output += new TextDecoder().decode(data);
    },
    bufferedAmount: () => v.buffered,
    ping() {},
    close(code) {
      v.closedWith = code ?? 1000;
    },
  };
  return v;
}

function types(v: FakeViewer): unknown[] {
  return v.messages.map((message) => message.type);
}

function registry(overrides: Partial<TerminalRegistryOptions> = {}) {
  const fake = fakeSpawn();
  const signals: [number, string][] = [];
  let clock = 1_000;
  const instance = new TerminalRegistry({
    detachMs: 50,
    resolveLaunch: async () => ({ companionPath: ACME }),
    mateCommand: ["bun", "cli.mjs"],
    env: { PATH: "/usr/bin", MATE_ARTIFACT_PATH: "/companions/other", MATE_REPO_PATH: "/repo" },
    spawn: fake.spawn,
    signalGroup: (pid, signal) => {
      signals.push([pid, signal]);
      const proc = fake.spawned.find((candidate) => candidate.pid === pid);
      if (signal === "SIGTERM") proc?.exit(143);
    },
    now: () => clock,
    limits: { termGraceMs: 20, reapMs: 20 },
    ...overrides,
  });
  return {
    registry: instance,
    ...fake,
    signals,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const START = { type: "start", agent: "claude", companion: "abc", cols: 80, rows: 24 };

async function started(r: ReturnType<typeof registry>, v = viewer()) {
  const connection = r.registry.connect(v);
  await connection.message(JSON.stringify(START));
  return {
    v,
    connection,
    sessionId: v.messages.find((m) => m.type === "ready")?.sessionId as string,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("terminalUnsupportedReason", () => {
  test("names the requirement off POSIX or without Bun's terminal", () => {
    expect(terminalUnsupportedReason("win32", { Terminal: class {} } as never)).toContain(
      "macOS or Linux",
    );
    expect(terminalUnsupportedReason("linux", {} as never)).toContain("Bun 1.3.5");
    expect(terminalUnsupportedReason("linux", { Terminal: class {} } as never)).toBeNull();
  });
});

describe("RingBuffer", () => {
  test("keeps the newest bytes within its bound", () => {
    const ring = new RingBuffer(5);
    const encode = (text: string) => new TextEncoder().encode(text);
    ring.push(encode("abc"));
    ring.push(encode("def"));
    expect(new TextDecoder().decode(ring.snapshot())).toBe("bcdef");
    ring.push(encode("0123456789"));
    expect(new TextDecoder().decode(ring.snapshot())).toBe("56789");
    expect(ring.byteLength).toBe(5);
  });
});

describe("launch", () => {
  test("starts only the managed launch against the effective companion", async () => {
    const r = registry();
    const { v } = await started(r);
    const request = r.spawned[0]!.request;
    expect(request.argv).toEqual(["bun", "cli.mjs", "claude", "--", "--companion", "--yes"]);
    expect(request.cwd).toBe(ACME);
    expect(request.env.MATE_ARTIFACT_PATH).toBe(ACME);
    expect(request.env.MATE_REPO_PATH).toBeUndefined();
    expect(types(v)).toEqual(["ready"]);
    await r.registry.stopAll();
  });

  test("passes --no-git when Git synchronization is off", async () => {
    const r = registry({ noGit: true });
    await started(r);
    expect(r.spawned[0]!.request.argv.at(-1)).toBe("--no-git");
    await r.registry.stopAll();
  });

  test.each([
    { name: "another command", message: { ...START, agent: "bash" } },
    { name: "an out-of-range size", message: { ...START, cols: 1 } },
  ])("refuses $name without spawning", async ({ message }) => {
    const r = registry();
    const v = viewer();
    await r.registry.connect(v).message(JSON.stringify(message));
    expect(r.spawned).toHaveLength(0);
    expect(types(v)).toEqual(["error"]);
  });

  test("refuses what the resolver refuses", async () => {
    const r = registry({ resolveLaunch: async () => ({ reason: "claude is not allowed" }) });
    const v = viewer();
    await r.registry.connect(v).message(JSON.stringify(START));
    expect(r.spawned).toHaveLength(0);
    expect(v.messages[0]).toEqual({ type: "error", reason: "claude is not allowed" });
  });

  test("reports the agent's exit status and ends the session", async () => {
    const r = registry();
    const { v } = await started(r);
    r.spawned[0]!.exit(3);
    await sleep(40);
    expect(v.messages.at(-1)).toEqual({ type: "exit", status: 3 });
    expect(r.registry.list()).toEqual([]);
  });
});

describe("createLaunchResolver", () => {
  const inventory = async () => ({
    companions: [
      { path: ACME, health: "ready" as const, pairings: [] },
      { path: "/companions/beta", health: "ready" as const, pairings: [] },
    ],
  });
  const { companionDigest } = require("./selection") as typeof import("./selection");

  test("resolves the page selection from the current inventory", async () => {
    const resolve = createLaunchResolver({
      collectInventory: inventory,
      launchableAgents: async () => ["claude"],
    });
    expect(await resolve("claude", companionDigest(ACME))).toEqual({ companionPath: ACME });
    expect(await resolve("claude", "0000000000")).toHaveProperty("reason");
    expect(await resolve("opencode", companionDigest(ACME))).toHaveProperty("reason");
  });

  test("a pinned companion overrides the page selection", async () => {
    const resolve = createLaunchResolver({
      collectInventory: inventory,
      launchCompanion: ACME,
      launchableAgents: async () => ["claude", "opencode"],
    });
    expect(await resolve("opencode", companionDigest("/companions/beta"))).toEqual({
      companionPath: ACME,
    });
    const gone = createLaunchResolver({
      collectInventory: async () => ({ companions: [] }),
      launchCompanion: ACME,
      launchableAgents: async () => ["claude"],
    });
    expect(await gone("claude", null)).toHaveProperty("reason");
  });
});

describe("viewing", () => {
  test("replays output produced before and while detached, then nudges the size", async () => {
    const r = registry({ detachMs: 10_000 });
    const { v, connection, sessionId } = await started(r);
    r.spawned[0]!.emit("early ");
    connection.closed();
    r.spawned[0]!.emit("while-detached");
    expect(r.registry.list()[0]!.attached).toBe(false);

    const next = viewer();
    await r.registry
      .connect(next)
      .message(JSON.stringify({ type: "attach", sessionId, cols: 100, rows: 30 }));
    expect(types(next)).toEqual(["ready"]);
    expect(next.output).toBe("early while-detached");
    expect(r.spawned[0]!.sizes.slice(-2)).toEqual([
      [100, 29],
      [100, 30],
    ]);
    expect(v.output).toBe("early ");
    await r.registry.stopAll();
  });

  test("a second viewer takes over and the first can no longer act", async () => {
    const r = registry();
    const first = await started(r);
    const second = viewer();
    await r.registry
      .connect(second)
      .message(JSON.stringify({ type: "attach", sessionId: first.sessionId, cols: 80, rows: 24 }));
    expect(types(first.v)).toContain("takenOver");
    expect(first.v.closedWith).toBe(4001);
    r.spawned[0]!.emit("x");
    expect(first.v.output).toBe("");
    expect(second.output).toBe("x");

    await first.connection.message(JSON.stringify({ type: "input", data: "rm" }));
    await first.connection.message(JSON.stringify({ type: "resize", cols: 90, rows: 20 }));
    expect(r.spawned[0]!.written).toEqual([]);
    expect(r.spawned[0]!.sizes).not.toContainEqual([90, 20]);
    await r.registry.stopAll();
  });

  test("a missed heartbeat detaches without ending the agent", async () => {
    const r = registry({ detachMs: 10_000 });
    const { v, connection } = await started(r);
    r.tick(20_000);
    connection.pong();
    r.registry.beat();
    expect(r.registry.list()[0]!.attached).toBe(true);
    r.tick(31_000);
    r.registry.beat();
    expect(types(v)).toContain("detached");
    expect(r.registry.list()[0]!.attached).toBe(false);
    expect(r.signals).toEqual([]);
    await r.registry.stopAll();
  });

  test("a detached session ends after its window; reattaching in time keeps it", async () => {
    const r = registry({ detachMs: 30 });
    const kept = await started(r);
    kept.connection.closed();
    await sleep(10);
    await r.registry
      .connect(viewer())
      .message(JSON.stringify({ type: "attach", sessionId: kept.sessionId, cols: 80, rows: 24 }));
    await sleep(60);
    expect(r.registry.list()).toHaveLength(1);

    const expired = await started(r);
    expired.connection.closed();
    await sleep(80);
    expect(r.registry.list().map((s) => s.id)).toEqual([kept.sessionId]);
    expect(r.signals).toContainEqual([r.spawned[1]!.pid, "SIGTERM"]);
    expect(r.signals).toContainEqual([r.spawned[1]!.pid, "SIGKILL"]);
    await r.registry.stopAll();
  });

  test("an unknown session is reported gone", async () => {
    const r = registry();
    const v = viewer();
    await r.registry
      .connect(v)
      .message(JSON.stringify({ type: "attach", sessionId: "nope", cols: 80, rows: 24 }));
    expect(v.messages[0]).toEqual({ type: "gone", sessionId: "nope" });
  });
});

describe("bounds", () => {
  test("rejects oversized input and out-of-range resizes without ending the session", async () => {
    const r = registry();
    const { v, connection } = await started(r);
    await connection.message(JSON.stringify({ type: "input", data: "x".repeat(64 * 1024 + 1) }));
    await connection.message(JSON.stringify({ type: "resize", cols: 501, rows: 20 }));
    await connection.message(JSON.stringify({ type: "resize", cols: 80, rows: 0 }));
    expect(r.spawned[0]!.written).toEqual([]);
    expect(r.spawned[0]!.sizes).toEqual([
      [80, 23],
      [80, 24],
    ]);
    expect(types(v).filter((type) => type === "error")).toHaveLength(3);
    await connection.message(JSON.stringify({ type: "input", data: "ok" }));
    expect(r.spawned[0]!.written).toEqual(["ok"]);
    expect(r.registry.list()).toHaveLength(1);
    await r.registry.stopAll();
  });

  test("output beyond the ring bound keeps the newest bytes and the session", async () => {
    const r = registry({ limits: { ringBytes: 8, termGraceMs: 20, reapMs: 20 } });
    const { connection, sessionId } = await started(r);
    connection.closed();
    r.spawned[0]!.emit("0123456789abcdef");
    const next = viewer();
    await r.registry
      .connect(next)
      .message(JSON.stringify({ type: "attach", sessionId, cols: 80, rows: 24 }));
    expect(next.output).toBe("89abcdef");
    await r.registry.stopAll();
  });

  test("a slow viewer is detached and the agent keeps running", async () => {
    const r = registry();
    const { v } = await started(r);
    v.buffered = 2 * 1024 * 1024;
    r.spawned[0]!.emit("flood");
    expect(v.messages.at(-1)).toEqual({ type: "detached", reason: "slow" });
    expect(r.registry.list()[0]!.attached).toBe(false);
    expect(r.signals).toEqual([]);
    await r.registry.stopAll();
  });

  test("at the cap the longest-detached session makes room", async () => {
    const r = registry({ detachMs: 60_000 });
    const sessions = [];
    for (let i = 0; i < 4; i += 1) {
      sessions.push(await started(r));
      r.tick(1_000);
    }
    sessions[2]!.connection.closed();
    r.tick(1_000);
    sessions[1]!.connection.closed();
    await started(r);
    expect(r.spawned).toHaveLength(5);
    const ids = r.registry.list().map((s) => s.id);
    expect(ids).not.toContain(sessions[2]!.sessionId);
    expect(ids).toContain(sessions[1]!.sessionId);
    await r.registry.stopAll();
  });

  test("four attached sessions refuse another before spawning", async () => {
    const r = registry();
    for (let i = 0; i < 4; i += 1) await started(r);
    const v = viewer();
    await r.registry.connect(v).message(JSON.stringify(START));
    expect(r.spawned).toHaveLength(4);
    expect(types(v)).toEqual(["error"]);
    await r.registry.stopAll();
  });

  test("one attached session per connection", async () => {
    const r = registry();
    const { v, connection } = await started(r);
    await connection.message(JSON.stringify(START));
    expect(r.spawned).toHaveLength(1);
    expect(types(v)).toEqual(["ready", "error"]);
    await r.registry.stopAll();
  });
});

describe("ending", () => {
  test("end stops a listed session and stopAll stops attached and detached ones", async () => {
    const r = registry({ detachMs: 60_000 });
    const one = await started(r);
    const two = await started(r);
    two.connection.closed();
    expect(await r.registry.end(one.sessionId)).toBe(true);
    expect(r.registry.list().map((s) => s.id)).toEqual([two.sessionId]);
    expect(await r.registry.end("nope")).toBe(false);
    await r.registry.stopAll();
    expect(r.registry.list()).toEqual([]);
    expect(r.signals.filter(([, signal]) => signal === "SIGKILL")).toHaveLength(2);
  });
});

const posix = process.platform !== "win32" && terminalUnsupportedReason() === null;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.if(posix)("real pseudo-terminal", () => {
  test("TERM then KILL on the group reaches an uncooperative grandchild", async () => {
    let output = "";
    const script =
      'trap "" TERM HUP; sh -c \'trap "" TERM HUP; echo GRAND $$; while :; do sleep 1; done\' & wait';
    const r = new TerminalRegistry({
      detachMs: 60_000,
      resolveLaunch: async () => ({ companionPath: process.cwd() }),
      mateCommand: [],
      spawn: (request) =>
        bunTerminalSpawn({
          ...request,
          argv: ["sh", "-c", script],
          onData: (data) => {
            output += new TextDecoder().decode(data);
            request.onData(data);
          },
        }),
      limits: { termGraceMs: 300, reapMs: 2_000 },
    });
    const v = viewer();
    await r.connect(v).message(JSON.stringify(START));
    for (let i = 0; i < 50 && !/GRAND \d+/.test(output); i += 1) await sleep(50);
    const grand = Number(/GRAND (\d+)/.exec(output)?.[1]);
    expect(grand).toBeGreaterThan(0);
    expect(alive(grand)).toBe(true);

    await r.stopAll();
    for (let i = 0; i < 20 && alive(grand); i += 1) await sleep(50);
    expect(alive(grand)).toBe(false);
  });

  test("a stub agent launches in the companion with the explicit path", async () => {
    let output = "";
    const r = new TerminalRegistry({
      detachMs: 60_000,
      resolveLaunch: async () => ({ companionPath: "/tmp" }),
      mateCommand: ["sh", "-c", 'echo "$0 $1 $MATE_ARTIFACT_PATH $(pwd -P)"'],
      env: { PATH: process.env.PATH, MATE_ARTIFACT_PATH: "/elsewhere" },
      spawn: (request) =>
        bunTerminalSpawn({
          ...request,
          onData: (data) => {
            output += new TextDecoder().decode(data);
            request.onData(data);
          },
        }),
    });
    const v = viewer();
    await r.connect(v).message(JSON.stringify({ ...START, agent: "opencode" }));
    for (let i = 0; i < 40 && !v.messages.some((m) => m.type === "exit"); i += 1) await sleep(50);
    expect(output).toContain("opencode -- /tmp");
    expect(output).toMatch(/\/tmp|\/private\/tmp/);
    await r.stopAll();
  });
});
