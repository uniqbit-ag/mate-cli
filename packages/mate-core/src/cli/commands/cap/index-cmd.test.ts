import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CapabilityConfig } from "../../../lib/orchestrator/types";
import { runIndexCapCommand, type SyncCapDeps } from "./index-cmd";

interface Invocation {
  runner: "graphify" | "tokensave";
  args: string[];
}

// Builds injected deps that record every reused-cap-command invocation and let each
// test script the process.exitCode a given call produces (the only channel the real
// runGraphifyCapCommand / runTokensaveCapCommand use to signal failure).
function makeDeps(options: {
  capabilities: CapabilityConfig[];
  ensureUnambiguousCompanion?: (cwd: string) => Promise<boolean>;
  tokensaveInitialized?: boolean;
  onEnsureTokensaveStoreExcluded?: () => Promise<void> | void;
  failGraphify?: (args: string[]) => boolean;
  failTokensave?: (args: string[]) => boolean;
}): { deps: SyncCapDeps; invocations: Invocation[] } {
  const invocations: Invocation[] = [];
  const deps: SyncCapDeps = {
    ensureUnambiguousCompanion: options.ensureUnambiguousCompanion ?? (async () => true),
    loadCapabilities: async () => options.capabilities,
    isTokensaveInitialized: async () => options.tokensaveInitialized ?? true,
    ensureTokensaveStoreExcluded: async () => {
      await options.onEnsureTokensaveStoreExcluded?.();
    },
    runGraphify: async (args) => {
      invocations.push({ runner: "graphify", args });
      if (options.failGraphify?.(args)) process.exitCode = 1;
    },
    runTokensave: async (args) => {
      invocations.push({ runner: "tokensave", args });
      if (options.failTokensave?.(args)) process.exitCode = 1;
    },
  };
  return { deps, invocations };
}

const cap = (name: string): CapabilityConfig => ({ name });

// process.exitCode is a shared global and `= undefined` does not reset it under Bun,
// so baseline every test to 0 (a clean "success" state) before it runs.
beforeEach(() => {
  process.exitCode = 0;
});

// Reset after each test so a trailing assertion of exitCode === 1 doesn't leak
// into the process exit code when this file runs last.
afterEach(() => {
  process.exitCode = 0;
});

describe("runIndexCapCommand", () => {
  test("skips graphify entirely when the capability is disabled", async () => {
    const { deps, invocations } = makeDeps({ capabilities: [cap("tokensave")] });

    await runIndexCapCommand(["--graphify"], deps);

    expect(invocations.some((i) => i.runner === "graphify")).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  test("runs graphify sync only when --graphify is passed", async () => {
    const { deps, invocations } = makeDeps({ capabilities: [cap("graphify")] });

    await runIndexCapCommand(["--graphify"], deps);

    expect(invocations).toEqual([{ runner: "graphify", args: [".", "--update", "--code-only"] }]);
    expect(process.exitCode).toBe(0);
  });

  test("runs tokensave sync only when --tokensave is passed", async () => {
    const { deps, invocations } = makeDeps({
      capabilities: [cap("graphify"), cap("tokensave")],
      tokensaveInitialized: true,
    });

    await runIndexCapCommand(["--tokensave"], deps);

    expect(invocations).toEqual([{ runner: "tokensave", args: ["sync"] }]);
    expect(process.exitCode).toBe(0);
  });

  test("fails when graphify update fails with --graphify", async () => {
    const { deps, invocations } = makeDeps({
      capabilities: [cap("graphify")],
      failGraphify: (args) => args[1] === "--update",
    });

    await runIndexCapCommand(["--graphify"], deps);

    expect(invocations).toEqual([{ runner: "graphify", args: [".", "--update", "--code-only"] }]);
    expect(process.exitCode).toBe(1);
  });

  test("skips tokensave entirely when the capability is disabled", async () => {
    const { deps, invocations } = makeDeps({ capabilities: [cap("graphify")] });

    await runIndexCapCommand([], deps);

    expect(invocations.some((i) => i.runner === "tokensave")).toBe(false);
  });

  test("skips tokensave when --graphify is passed", async () => {
    const { deps, invocations } = makeDeps({
      capabilities: [cap("graphify"), cap("tokensave")],
      tokensaveInitialized: true,
    });

    await runIndexCapCommand(["--graphify"], deps);

    expect(invocations).toEqual([{ runner: "graphify", args: [".", "--update", "--code-only"] }]);
    expect(process.exitCode).toBe(0);
  });

  test("skips graphify when --tokensave is passed", async () => {
    const { deps, invocations } = makeDeps({
      capabilities: [cap("graphify"), cap("tokensave")],
      tokensaveInitialized: true,
    });

    await runIndexCapCommand(["--tokensave"], deps);

    expect(invocations).toEqual([{ runner: "tokensave", args: ["sync"] }]);
    expect(process.exitCode).toBe(0);
  });

  test("fails without running tokensave when the graphify branch fails", async () => {
    const { deps, invocations } = makeDeps({
      capabilities: [cap("graphify"), cap("tokensave")],
      tokensaveInitialized: true,
      failGraphify: (args) => args[1] === "--update",
    });

    await runIndexCapCommand(["--graphify"], deps);

    expect(invocations).toEqual([{ runner: "graphify", args: [".", "--update", "--code-only"] }]);
    expect(process.exitCode).toBe(1);
  });

  test("runs tokensave and graphify sync by default when both are enabled", async () => {
    const { deps, invocations } = makeDeps({
      capabilities: [cap("graphify"), cap("tokensave")],
      tokensaveInitialized: true,
    });

    await runIndexCapCommand([], deps);

    expect(invocations).toEqual([
      { runner: "tokensave", args: ["sync"] },
      { runner: "graphify", args: [".", "--update", "--code-only"] },
    ]);
    expect(process.exitCode).toBe(0);
  });

  test("runs tokensave sync when graphify is disabled", async () => {
    const { deps, invocations } = makeDeps({
      capabilities: [cap("tokensave")],
      tokensaveInitialized: true,
    });

    await runIndexCapCommand([], deps);

    expect(invocations).toEqual([{ runner: "tokensave", args: ["sync"] }]);
    expect(process.exitCode).toBe(0);
  });

  test("runs tokensave init before sync when the store is missing", async () => {
    const calls: string[] = [];
    const { deps, invocations } = makeDeps({
      capabilities: [cap("tokensave")],
      tokensaveInitialized: false,
      onEnsureTokensaveStoreExcluded: () => {
        calls.push("exclude");
      },
    });

    await runIndexCapCommand([], deps);

    expect(calls).toEqual(["exclude"]);
    expect(invocations).toEqual([
      { runner: "tokensave", args: ["init"] },
      { runner: "tokensave", args: ["sync"] },
    ]);
    expect(process.exitCode).toBe(0);
  });

  test("exits zero when the graphify branch succeeds", async () => {
    const { deps, invocations } = makeDeps({
      capabilities: [cap("graphify"), cap("tokensave")],
      tokensaveInitialized: true,
    });

    await runIndexCapCommand(["--graphify"], deps);

    expect(invocations).toEqual([{ runner: "graphify", args: [".", "--update", "--code-only"] }]);
    expect(process.exitCode).toBe(0);
  });

  test("writes nothing and exits zero when neither capability is enabled", async () => {
    const { deps, invocations } = makeDeps({ capabilities: [] });

    await runIndexCapCommand([], deps);

    expect(invocations).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  test("fails when only the tokensave branch fails", async () => {
    const { deps, invocations } = makeDeps({
      capabilities: [cap("graphify"), cap("tokensave")],
      tokensaveInitialized: true,
      failTokensave: () => true,
    });

    await runIndexCapCommand([], deps);

    expect(invocations).toEqual([
      { runner: "tokensave", args: ["sync"] },
      { runner: "graphify", args: [".", "--update", "--code-only"] },
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("fails when graphify update fails after tokensave succeeds", async () => {
    const { deps, invocations } = makeDeps({
      capabilities: [cap("graphify"), cap("tokensave")],
      tokensaveInitialized: true,
      failGraphify: (args) => args[1] === "--update",
    });

    await runIndexCapCommand([], deps);

    expect(invocations).toEqual([
      { runner: "tokensave", args: ["sync"] },
      { runner: "graphify", args: [".", "--update", "--code-only"] },
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("fails and skips sync when tokensave init fails", async () => {
    const { deps, invocations } = makeDeps({
      capabilities: [cap("tokensave")],
      tokensaveInitialized: false,
      failTokensave: (args) => args[0] === "init",
    });

    await runIndexCapCommand([], deps);

    expect(invocations).toEqual([{ runner: "tokensave", args: ["init"] }]);
    expect(process.exitCode).toBe(1);
  });

  test("fails fast on unknown sync options", async () => {
    const { deps, invocations } = makeDeps({ capabilities: [cap("graphify"), cap("tokensave")] });

    await runIndexCapCommand(["--wat"], deps);

    expect(invocations).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("fails fast when known and unknown sync options are mixed", async () => {
    const { deps, invocations } = makeDeps({ capabilities: [cap("graphify"), cap("tokensave")] });

    await runIndexCapCommand(["--graphify", "--wat"], deps);

    expect(invocations).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("fails fast when --graphify and --tokensave are mixed", async () => {
    const { deps, invocations } = makeDeps({ capabilities: [cap("graphify"), cap("tokensave")] });

    await runIndexCapCommand(["--graphify", "--tokensave"], deps);

    expect(invocations).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("aborts before indexing when companion selection cannot be resolved", async () => {
    const { deps, invocations } = makeDeps({
      capabilities: [cap("graphify"), cap("tokensave")],
      ensureUnambiguousCompanion: async () => false,
    });

    await runIndexCapCommand([], deps);

    expect(invocations).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});
