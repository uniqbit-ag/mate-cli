import { describe, expect, test } from "bun:test";

import type { RegisteredSession } from "../runtime/session-registry";
import {
  registersHere,
  runNotificationHook,
  runSessionEndHook,
  type SessionRegisterDeps,
} from "./session-register";

function fake(wrapped: boolean, fail = false) {
  const ended: string[] = [];
  const patched: Array<[string, Partial<RegisteredSession>]> = [];
  const deps: SessionRegisterDeps = {
    register: async () => {},
    refresh: async () => {},
    registered: async () => true,
    end: async (id) => {
      if (fail) throw new Error("locked");
      ended.push(id);
    },
    patch: async (id, patch) => {
      if (fail) throw new Error("locked");
      patched.push([id, patch]);
    },
    branch: async () => null,
    wrappedForClaude: () => wrapped,
    now: () => new Date("2026-03-01T10:00:00.000Z"),
  };
  return { deps, ended, patched };
}

const call = (input: unknown) => ({ env: {}, cwd: "/w/acme", argv: [], input });

describe("session registry hooks", () => {
  test("SessionEnd ends the session from the wrap's copy", async () => {
    const { deps, ended } = fake(true);
    const outcome = await runSessionEndHook(call({ session_id: "s1" }), true, deps);
    expect(outcome).toEqual({ exitCode: 0, stdout: "" });
    expect(ended).toEqual(["s1"]);
  });

  test("the plugin's copy records only where the repository is not wrapped", async () => {
    const wrapped = fake(true);
    await runSessionEndHook(call({ session_id: "s1" }), false, wrapped.deps);
    expect(wrapped.ended).toEqual([]);

    const unwrapped = fake(false);
    await runSessionEndHook(call({ session_id: "s1" }), false, unwrapped.deps);
    expect(unwrapped.ended).toEqual(["s1"]);
  });

  test("Notification sets attentionAt", async () => {
    const { deps, patched } = fake(true);
    await runNotificationHook(call({ session_id: "s1", message: "permission" }), true, deps);
    expect(patched).toEqual([["s1", { attentionAt: "2026-03-01T10:00:00.000Z" }]]);
  });

  test("a failing write and input without a session id exit zero silently", async () => {
    const { deps } = fake(true, true);
    expect(await runSessionEndHook(call({ session_id: "s1" }), true, deps)).toEqual({
      exitCode: 0,
      stdout: "",
    });
    expect(await runNotificationHook(call(null), true, deps)).toEqual({ exitCode: 0, stdout: "" });
  });

  test("an unregistered session costs one registry read, no wrap check", async () => {
    const { deps, ended } = fake(false);
    let wrapChecks = 0;
    deps.registered = async () => false;
    deps.wrappedForClaude = () => {
      wrapChecks += 1;
      return false;
    };
    await runSessionEndHook(call({ session_id: "s1" }), false, deps);
    await runNotificationHook(call({ session_id: "s1" }), false, deps);
    expect([ended, wrapChecks]).toEqual([[], 0]);
  });

  test("a throwing wrap check counts as unwrapped", () => {
    expect(
      registersHere(false, "/w/acme", {
        wrappedForClaude: () => {
          throw new Error("unreadable manifest");
        },
      }),
    ).toBe(true);
  });
});
