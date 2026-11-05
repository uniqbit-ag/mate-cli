import { describe, expect, test } from "bun:test";

import type { SessionInput } from "../runtime/session-registry";
import { registerOpenCodeSessions, type OpenCodeRegisterDeps } from "./session-register";

function fakeApi(directory: string) {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  const hooks = new Map<string, (event: { sessionID: string }) => void>();
  const api = {
    location: { directory },
    session: {
      hook: async (name: string, handler: (event: { sessionID: string }) => void) => {
        hooks.set(name, handler);
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
  return { api: api as never, hooks, emit };
}

function fakeDeps(unknown: string[] = [], endedIds = new Set<string>()) {
  const registered: SessionInput[] = [];
  const labels: Array<[string, string]> = [];
  const ended: string[] = [];
  const activities: Array<[string, string, string | undefined]> = [];
  const deps: OpenCodeRegisterDeps = {
    register: async (input) => {
      registered.push(input);
      return input;
    },
    registered: async (id) => !unknown.includes(id),
    ended: async (id) => endedIds.has(id),
    label: async (id, label) => void labels.push([id, label]),
    activity: async (id, activity, attentionAt) =>
      void activities.push([id, activity, attentionAt]),
    end: async (id) => void ended.push(id),
    branch: async () => "workset/acme",
    pid: 4242,
    now: () => new Date("2026-11-05T10:00:00Z"),
  };
  return { deps, registered, labels, ended, activities };
}

const created = (sessionID: string, extra: Record<string, unknown> = {}) => ({
  type: "session.created",
  data: { sessionID, location: { directory: "/w/acme" }, ...extra },
});

describe("OpenCode session registration", () => {
  test("registers created sessions of this location, labels on rename, ends on delete", async () => {
    const { api, emit } = fakeApi("/w/acme");
    const { deps, registered, labels, ended } = fakeDeps();
    const cleanup = await registerOpenCodeSessions(api, deps);

    await emit(created("ses_1"));
    await emit(created("ses_sub", { parentID: "ses_1" }));
    await emit({
      type: "session.created",
      data: { sessionID: "ses_other", location: { directory: "/w/acme-api" } },
    });
    await emit({ type: "session.renamed", data: { sessionID: "ses_1", title: "Queue retries" } });
    await emit({ type: "session.deleted", data: { sessionID: "ses_1" } });

    expect(registered).toEqual([
      {
        id: "ses_1",
        runtime: "opencode",
        cwd: "/w/acme",
        pid: 4242,
        branch: "workset/acme",
      },
    ]);
    expect(labels).toEqual([["ses_1", "Queue retries"]]);
    expect(ended).toEqual(["ses_1"]);
    await cleanup();
  });

  test("a resumed session refreshes on its first prompt, once", async () => {
    const { api, hooks } = fakeApi("/w/acme");
    const { deps, registered } = fakeDeps();
    const cleanup = await registerOpenCodeSessions(api, deps);

    hooks.get("prompt")!({ sessionID: "ses_2" });
    hooks.get("prompt")!({ sessionID: "ses_2" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(registered.map((input) => input.id)).toEqual(["ses_2"]);
    await cleanup();
  });

  test("a prompt to a session stopped while this server ran refreshes it again", async () => {
    const { api, hooks } = fakeApi("/w/acme");
    const endedIds = new Set<string>();
    const { deps, registered } = fakeDeps([], endedIds);
    const cleanup = await registerOpenCodeSessions(api, deps);
    const prompt = async () => {
      hooks.get("prompt")!({ sessionID: "ses_2" });
      await new Promise((resolve) => setTimeout(resolve, 5));
    };

    await prompt();
    endedIds.add("ses_2");
    await prompt();
    endedIds.delete("ses_2");
    await prompt();

    expect(registered.map((input) => input.id)).toEqual(["ses_2", "ses_2"]);
    await cleanup();
  });

  test("a session no editor registered writes nothing", async () => {
    const { api, emit } = fakeApi("/w/acme");
    const { deps, registered, activities, ended } = fakeDeps(["ses_own"]);
    const cleanup = await registerOpenCodeSessions(api, deps);
    await emit(created("ses_own"));
    await emit({ type: "session.step.started", data: { sessionID: "ses_own" } });
    await cleanup();
    expect([registered, activities, ended]).toEqual([[], [], []]);
  });

  test("cleanup ends every session this process registered", async () => {
    const { api, emit } = fakeApi("/w/acme");
    const { deps, ended } = fakeDeps();
    const cleanup = await registerOpenCodeSessions(api, deps);
    await emit(created("ses_a"));
    await emit(created("ses_b"));
    await cleanup();
    expect(ended.toSorted()).toEqual(["ses_a", "ses_b"]);
  });

  test("a failing registry write never throws into OpenCode", async () => {
    const { api, emit } = fakeApi("/w/acme");
    const { deps } = fakeDeps();
    deps.register = async () => {
      throw new Error("locked");
    };
    const cleanup = await registerOpenCodeSessions(api, deps);
    await emit(created("ses_x"));
    await cleanup();
  });

  test("stores activity on change and attention on each permission request", async () => {
    const { api, emit } = fakeApi("/w/acme");
    const { deps, activities } = fakeDeps();
    const cleanup = await registerOpenCodeSessions(api, deps);
    const step = (type: string, data: Record<string, unknown> = {}) =>
      emit({ type, data: { sessionID: "ses_1", ...data } });

    await emit(created("ses_1"));
    await step("session.step.started");
    await step("session.step.ended", { finish: "tool-calls" });
    await step("session.step.started");
    await step("permission.asked");
    await step("permission.asked");
    await step("permission.replied");
    await step("session.step.ended", { finish: "stop" });
    await emit({ type: "session.step.started", data: { sessionID: "ses_unknown" } });

    const at = "2026-11-05T10:00:00.000Z";
    expect(activities).toEqual([
      ["ses_1", "working", undefined],
      ["ses_1", "waiting", at],
      ["ses_1", "waiting", at],
      ["ses_1", "working", undefined],
      ["ses_1", "idle", undefined],
    ]);
    await cleanup();
  });

  test("a kept cleanup leaves registered sessions running", async () => {
    const { api, emit } = fakeApi("/w/acme");
    const { deps, ended } = fakeDeps();
    const cleanup = await registerOpenCodeSessions(api, deps);
    await emit(created("ses_1"));
    await cleanup({ keepSessions: true });
    expect(ended).toEqual([]);
  });
});
