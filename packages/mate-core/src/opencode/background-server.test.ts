import { afterEach, describe, expect, test } from "bun:test";

import { registerMateServer, resetMateServer, type MateServerDeps } from "./background-server";

function fakeApi() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  const shellHooks: Array<(event: { env: Record<string, string | undefined> }) => void> = [];
  const api = {
    location: { directory: "/w/acme" },
    shell: {
      hook: async (_name: string, handler: (typeof shellHooks)[number]) => {
        shellHooks.push(handler);
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
  const emit = async (type: string, data: Record<string, unknown> = {}) => {
    queue.push({ type, data: { sessionID: "ses_1", ...data } });
    wake?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { api: api as never, shellHooks, emit };
}

function fakeDeps() {
  let now = 0;
  let check: (() => void) | undefined;
  const exits: number[] = [];
  const removed: number[] = [];
  const deps: MateServerDeps = {
    now: () => now,
    exit: (code) => void exits.push(code),
    every: (fn) => {
      check = fn;
    },
    removeRecord: async (pid) => void removed.push(pid),
    pid: 777,
  };
  const advance = async (minutes: number) => {
    now += minutes * 60_000;
    check?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { deps, exits, removed, advance };
}

const serverEnv = () => ({
  MATE_OPENCODE_SERVER: "1",
  OPENCODE_SERVER_PASSWORD: "secret",
  OPENCODE_PASSWORD: "secret",
  HOME: "/home/acme",
});

afterEach(resetMateServer);

describe("a Mate OpenCode server", () => {
  test("drops the passwords from its env and from every shell", async () => {
    const { api, shellHooks } = fakeApi();
    const env = serverEnv();
    const location = await registerMateServer(api, env, fakeDeps().deps);

    expect(env).toEqual({ MATE_OPENCODE_SERVER: "1", HOME: "/home/acme" });
    const shell = { env: serverEnv() as Record<string, string | undefined> };
    shellHooks[0]?.(shell);
    expect(shell.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(shell.env.OPENCODE_PASSWORD).toBeUndefined();
    location?.dispose();
  });

  test("stops after an idle hour: ends sessions, removes its record, exits", async () => {
    const { api, emit } = fakeApi();
    const fake = fakeDeps();
    const ended: string[] = [];
    const location = await registerMateServer(api, serverEnv(), fake.deps);
    location?.onStop(async () => void ended.push("ses_1"));

    await emit("session.step.started");
    await fake.advance(90);
    expect(fake.exits).toEqual([]);

    await emit("session.step.ended", { finish: "tool-calls" });
    await fake.advance(90);
    expect(fake.exits).toEqual([]);

    await emit("session.step.ended", { finish: "stop" });
    await fake.advance(59);
    expect(fake.exits).toEqual([]);

    await fake.advance(2);
    expect(ended).toEqual(["ses_1"]);
    expect(fake.removed).toEqual([777]);
    expect(fake.exits).toEqual([0]);
    location?.dispose();
  });

  test("a failed step ends the turn", async () => {
    const { api, emit } = fakeApi();
    const fake = fakeDeps();
    const location = await registerMateServer(api, serverEnv(), fake.deps);
    await emit("session.step.started");
    await emit("session.step.failed");
    await fake.advance(61);
    expect(fake.exits).toEqual([0]);
    location?.dispose();
  });

  test("is inert outside a Mate OpenCode server", async () => {
    const { api, shellHooks } = fakeApi();
    const env = { OPENCODE_SERVER_PASSWORD: "secret" };
    const fake = fakeDeps();
    expect(await registerMateServer(api, env, fake.deps)).toBeUndefined();
    expect(env.OPENCODE_SERVER_PASSWORD).toBe("secret");
    expect(shellHooks).toHaveLength(0);
    await fake.advance(120);
    expect(fake.exits).toEqual([]);
  });
});
