import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  launcherInvocation,
  parsePrepareOutput,
  PREPARE_TIMEOUT_MS,
  spawnPrepareRunner,
  type PrepareRequest,
  type PrepareRun,
} from "../runtime/session-prepare-runner";
import { registerSessionPrepare, resetPrepareDebounce } from "./session-prepare";
import { readSessionNotes } from "./session-notes";

type McpConfig = { disabled?: boolean };

/** An MCP editor over a live map, plus an event stream the test pushes into. */
function fakeApi(servers: Record<string, McpConfig>) {
  const transforms: Array<(editor: unknown) => void> = [];
  const effective = () => {
    const copy: Record<string, McpConfig> = Object.fromEntries(
      Object.entries(servers).map(([name, config]) => [name, { ...config }]),
    );
    const editor = {
      get: (name: string) => copy[name],
      update: (name: string, update: (config: McpConfig) => void) => update(copy[name]!),
    };
    for (const transform of transforms) transform(editor);
    return copy;
  };
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  const reloads: Array<Record<string, McpConfig>> = [];
  const api = {
    mcp: {
      transform: async (callback: (editor: unknown) => void) => {
        transforms.push(callback);
        return { dispose: async () => {} };
      },
      reload: async () => {
        reloads.push(effective());
      },
    },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            continue;
          }
          yield queue.shift();
        }
      },
    },
  };
  const emit = async (event: unknown) => {
    queue.push(event);
    wake?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { api: api as never, effective, reloads, emit };
}

function recordingRunner(result: PrepareRun = { ok: true, notes: [] }) {
  const runs: PrepareRequest[] = [];
  const run = async (request: PrepareRequest) => {
    runs.push(request);
    return result;
  };
  return { runs, run, syncs: () => runs.filter((request) => request.sync) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const base = {
  directory: "/work/acme",
  repoPath: "/work/acme",
  companionPath: "/companions/acme",
  debounceMs: 1_000,
};

beforeEach(() => resetPrepareDebounce());

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("registerSessionPrepare", () => {
  test("holds Mate MCP servers until the prepare ends, leaving user servers alone", async () => {
    const { api, effective, reloads } = fakeApi({ tokensave: {}, acme: {} });
    let duringLocal: Record<string, McpConfig> = {};
    const run = async (request: PrepareRequest): Promise<PrepareRun> => {
      if (!request.sync) duringLocal = effective();
      return { ok: true, notes: [] };
    };

    cleanups.push(await registerSessionPrepare(api, { ...base, mateServers: ["tokensave"], run }));

    expect(duringLocal.tokensave?.disabled).toBe(true);
    expect(duringLocal.acme?.disabled).toBeUndefined();
    expect(reloads.at(-1)?.tokensave?.disabled).toBeUndefined();
  });

  test("awaits the local phase bounded by the timeout, then starts one sync", async () => {
    const { api } = fakeApi({});
    const runner = recordingRunner();

    cleanups.push(await registerSessionPrepare(api, { ...base, mateServers: [], run: runner.run }));

    expect(runner.runs).toEqual([{ sync: false, timeoutMs: PREPARE_TIMEOUT_MS }, { sync: true }]);
  });

  test("does not wait for the sync, and starts it only after the servers are released", async () => {
    const { api, reloads } = fakeApi({ tokensave: {} });
    let reloadsAtSync = -1;
    const run = (request: PrepareRequest): Promise<PrepareRun> => {
      if (!request.sync) return Promise.resolve({ ok: true, notes: [] });
      reloadsAtSync = reloads.length;
      return new Promise(() => {});
    };

    cleanups.push(await registerSessionPrepare(api, { ...base, mateServers: ["tokensave"], run }));

    expect(reloadsAtSync).toBe(1);
  });

  test("reports a sync that did not finish once it ends", async () => {
    const { api } = fakeApi({});
    const lines: string[] = [];
    let finish!: (run: PrepareRun) => void;
    const run = (request: PrepareRequest): Promise<PrepareRun> =>
      request.sync
        ? new Promise((resolve) => (finish = resolve))
        : Promise.resolve({ ok: true, notes: [] });

    cleanups.push(
      await registerSessionPrepare(api, {
        ...base,
        mateServers: [],
        run,
        log: (line) => lines.push(line),
      }),
    );
    expect(lines).toEqual([]);

    finish({ ok: true, notes: ["companion Git synchronization unfinished: offline"] });
    await settle();

    expect(lines.join("\n")).toContain("offline");
  });

  test("a sync that moved the companion reloads the MCP servers and says so", async () => {
    const { api, reloads } = fakeApi({ tokensave: {} });
    const lines: string[] = [];
    let finish!: (run: PrepareRun) => void;
    const run = (request: PrepareRequest): Promise<PrepareRun> =>
      request.sync
        ? new Promise((resolve) => (finish = resolve))
        : Promise.resolve({ ok: true, notes: [] });

    cleanups.push(
      await registerSessionPrepare(api, {
        ...base,
        mateServers: ["tokensave"],
        run,
        log: (line) => lines.push(line),
      }),
    );
    expect(reloads).toHaveLength(1);

    finish({ ok: true, notes: [], changed: true });
    await settle();

    expect(reloads).toHaveLength(2);
    expect(reloads.at(-1)?.tokensave?.disabled).toBeUndefined();
    expect(lines.join("\n")).toContain("companion updated");
    expect(lines.join("\n")).not.toContain("Restart");
  });

  test("a sync that left the companion as it was reloads nothing", async () => {
    const { api, reloads } = fakeApi({ tokensave: {} });
    const lines: string[] = [];

    cleanups.push(
      await registerSessionPrepare(api, {
        ...base,
        mateServers: ["tokensave"],
        run: recordingRunner().run,
        log: (line) => lines.push(line),
      }),
    );
    await settle();

    expect(reloads).toHaveLength(1);
    expect(lines).toEqual([]);
  });

  test("a failed prepare is logged and still releases the servers", async () => {
    const { api, reloads } = fakeApi({ tokensave: {} });
    const lines: string[] = [];
    const run = async (): Promise<PrepareRun> => ({ ok: false, notes: ["preflight: acme"] });

    cleanups.push(
      await registerSessionPrepare(api, {
        ...base,
        mateServers: ["tokensave"],
        run,
        log: (line) => lines.push(line),
      }),
    );

    expect(lines.join("\n")).toContain("preflight: acme");
    expect(reloads.at(-1)?.tokensave?.disabled).toBeUndefined();
  });

  test("records failed-step notes for the TUI toast and clears them once a run is clean", async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "acme-notes-"));
    cleanups.push(() => fs.rm(repoPath, { recursive: true, force: true }));
    let result: PrepareRun = { ok: false, notes: ["preflight: acme"] };
    const run = async (request: PrepareRequest): Promise<PrepareRun> =>
      request.sync ? { ok: true, notes: [] } : result;
    const options = { ...base, repoPath, mateServers: [], run, log: () => {} };

    cleanups.push(await registerSessionPrepare(fakeApi({}).api, options));
    await settle();
    expect(readSessionNotes(repoPath)).toEqual(["preflight: acme"]);

    resetPrepareDebounce();
    result = { ok: true, notes: [] };
    cleanups.push(await registerSessionPrepare(fakeApi({}).api, options));
    await settle();
    expect(readSessionNotes(repoPath)).toEqual([]);
  });

  test("ignores sessions of another location and debounces a burst", async () => {
    const { api, emit } = fakeApi({});
    const runner = recordingRunner();
    cleanups.push(
      await registerSessionPrepare(api, {
        ...base,
        debounceMs: 0,
        mateServers: [],
        run: runner.run,
      }),
    );
    runner.runs.length = 0;

    await emit({ type: "session.created", location: { directory: "/work/other" } });
    expect(runner.runs).toEqual([]);

    resetPrepareDebounce();
    cleanups.push(
      await registerSessionPrepare(api, {
        ...base,
        debounceMs: 60_000,
        mateServers: [],
        run: runner.run,
      }),
    );
    runner.runs.length = 0;
    for (let index = 0; index < 3; index += 1) {
      await emit({ type: "session.created", location: { directory: base.directory } });
    }
    expect(runner.runs).toEqual([]);
  });

  test("re-prepares a new session of its own location once the window passed", async () => {
    const { api, emit } = fakeApi({});
    const runner = recordingRunner();
    cleanups.push(
      await registerSessionPrepare(api, {
        ...base,
        debounceMs: 0,
        mateServers: [],
        run: runner.run,
      }),
    );
    runner.runs.length = 0;

    await emit({ type: "session.created", data: { location: { directory: base.directory } } });

    expect(runner.runs).toEqual([{ sync: true }]);
  });
});

describe("spawnPrepareRunner", () => {
  async function fakeMate(script: string): Promise<{ bin: string; root: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate prepare "));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "runtime dir", "mate");
    await fs.mkdir(path.dirname(bin), { recursive: true });
    await fs.writeFile(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return { bin, root };
  }

  test.skipIf(process.platform === "win32")(
    "runs a launcher whose path has spaces, passing --sync only for the sync",
    async () => {
      const { bin, root } = await fakeMate(
        `echo "$@" >> "$(dirname "$0")/args"\necho '{"ok":true,"steps":[],"warnings":[]}'`,
      );
      const run = spawnPrepareRunner(bin, root);

      expect(await run({ sync: false, timeoutMs: 5_000 })).toEqual({ ok: true, notes: [] });
      expect(await run({ sync: true })).toEqual({ ok: true, notes: [] });

      const args = (await fs.readFile(path.join(path.dirname(bin), "args"), "utf8")).split("\n");
      expect(args[0]).toBe(`session prepare --repo ${root} --json`);
      expect(args[1]).toBe(`session prepare --repo ${root} --json --sync`);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a timeout stops waiting and never terminates the prepare",
    async () => {
      const { bin, root } = await fakeMate(
        `sleep 0.4\ntouch "$(dirname "$0")/finished"\necho '{"ok":true}'`,
      );
      const run = spawnPrepareRunner(bin, root);

      const result = await run({ sync: false, timeoutMs: 50 });

      expect(result.ok).toBe(false);
      expect(result.notes.join(" ")).toContain("timed out");
      await new Promise((resolve) => setTimeout(resolve, 800));
      await expect(fs.access(path.join(path.dirname(bin), "finished"))).resolves.toBeNull();
    },
  );
});

describe("launcherInvocation", () => {
  test("runs the launcher itself outside Windows", () => {
    expect(launcherInvocation("/home/acme/.mate/runtime/bin/mate", ["--json"], "linux")).toEqual({
      command: "/home/acme/.mate/runtime/bin/mate",
      args: ["--json"],
      verbatim: false,
    });
  });

  test("quotes a .cmd launcher and arguments with spaces for cmd.exe on Windows", () => {
    const invocation = launcherInvocation(
      "C:\\Users\\Acme Corp\\.mate\\runtime\\bin\\mate.cmd",
      ["--repo", "C:\\work\\my repo", "--json"],
      "win32",
    );

    expect(invocation.verbatim).toBe(true);
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toBe(
      '""C:\\Users\\Acme Corp\\.mate\\runtime\\bin\\mate.cmd" --repo "C:\\work\\my repo" --json"',
    );
  });
});

describe("parsePrepareOutput", () => {
  test("names failed steps and warnings", () => {
    const run = parsePrepareOutput(
      JSON.stringify({
        ok: false,
        steps: [{ step: "preflight", outcome: "failed", detail: "acme" }],
        warnings: ["shadowed"],
      }),
      1,
    );
    expect(run).toEqual({ ok: false, notes: ["preflight: acme", "shadowed"] });
  });

  test("marks a sync that moved the companion as changed", () => {
    const output = (companionChanged?: true) => JSON.stringify({ ok: true, companionChanged });
    expect(parsePrepareOutput(output(true), 0).changed).toBe(true);
    expect(parsePrepareOutput(output(), 0).changed).toBeUndefined();
  });

  test("treats unparseable output as a failure", () => {
    expect(parsePrepareOutput("boom", 2).ok).toBe(false);
  });
});
