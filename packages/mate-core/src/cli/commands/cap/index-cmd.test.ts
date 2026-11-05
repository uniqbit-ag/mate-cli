import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTempDir } from "../../../../../../test/fixtures";
import { addWorktree, initRepo } from "../../../../test/git-checkouts";
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
  onEnsureTokensaveBranchingPosture?: () => Promise<void> | void;
  failGraphify?: (args: string[]) => boolean;
  failTokensave?: (args: string[]) => boolean;
  onTokensave?: (args: string[]) => void;
}): { deps: SyncCapDeps; invocations: Invocation[] } {
  const invocations: Invocation[] = [];
  const deps: SyncCapDeps = {
    ensureUnambiguousCompanion: options.ensureUnambiguousCompanion ?? (async () => true),
    loadCapabilities: async () => options.capabilities,
    resolveRepositoryPath: async () => undefined,
    isTokensaveInitialized: async () => options.tokensaveInitialized ?? true,
    ensureTokensaveStoreExcluded: async () => {
      await options.onEnsureTokensaveStoreExcluded?.();
    },
    ensureTokensaveBranchingPosture: async () => {
      await options.onEnsureTokensaveBranchingPosture?.();
    },
    runGraphify: async (args) => {
      invocations.push({ runner: "graphify", args });
      if (options.failGraphify?.(args)) process.exitCode = 1;
    },
    runTokensave: async (args) => {
      invocations.push({ runner: "tokensave", args });
      options.onTokensave?.(args);
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
      { runner: "tokensave", args: ["init", "--no-git-hook"] },
      { runner: "tokensave", args: ["sync"] },
    ]);
    expect(process.exitCode).toBe(0);
  });

  test("reconciles the branching posture after init and before sync on a fresh store", async () => {
    const calls: string[] = [];
    const { deps } = makeDeps({
      capabilities: [cap("tokensave")],
      tokensaveInitialized: false,
      onEnsureTokensaveStoreExcluded: () => {
        calls.push("exclude");
      },
      onEnsureTokensaveBranchingPosture: () => {
        calls.push("posture");
      },
      onTokensave: (args) => {
        calls.push(`tokensave ${args.join(" ")}`);
      },
    });

    await runIndexCapCommand([], deps);

    expect(calls).toEqual(["exclude", "tokensave init --no-git-hook", "posture", "tokensave sync"]);
    expect(process.exitCode).toBe(0);
  });

  test("skips posture reconciliation when init fails", async () => {
    const calls: string[] = [];
    const { deps } = makeDeps({
      capabilities: [cap("tokensave")],
      tokensaveInitialized: false,
      failTokensave: (args) => args[0] === "init",
      onEnsureTokensaveBranchingPosture: () => {
        calls.push("posture");
      },
    });

    await runIndexCapCommand([], deps);

    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("reconciles the branching posture before sync on an initialized store", async () => {
    const calls: string[] = [];
    const { deps } = makeDeps({
      capabilities: [cap("tokensave")],
      tokensaveInitialized: true,
      onEnsureTokensaveBranchingPosture: () => {
        calls.push("posture");
      },
      onTokensave: (args) => {
        calls.push(`tokensave ${args.join(" ")}`);
      },
    });

    await runIndexCapCommand([], deps);

    expect(calls).toEqual(["posture", "tokensave sync"]);
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

    expect(invocations).toEqual([{ runner: "tokensave", args: ["init", "--no-git-hook"] }]);
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

describe("runIndexCapCommand tokensave checkout", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function checkouts() {
    const root = await createTempDir("mate-cap-index-");
    roots.push(root);
    const main = initRepo(path.join(root, "acme"));
    const worktree = addWorktree(main, path.join(root, "acme.worktrees", "fix"));
    await fs.mkdir(path.join(main, ".tokensave"), { recursive: true });
    await fs.writeFile(path.join(main, ".tokensave", "tokensave.db"), "");
    return { main, worktree };
  }

  /** Runs the tokensave step from `cwd` with the Working Repository resolved to `main`. */
  async function indexFrom(cwd: string, main: string) {
    const touched: string[] = [];
    const { deps, invocations } = makeDeps({ capabilities: [cap("tokensave")] });
    await runIndexCapCommand(["--tokensave"], {
      ...deps,
      resolveRepositoryPath: async () => main,
      cwd: () => cwd,
      isTokensaveInitialized: undefined,
      ensureTokensaveStoreExcluded: async (repoPath) => void touched.push(`exclude ${repoPath}`),
      ensureTokensaveBranchingPosture: async (repoPath) => void touched.push(`posture ${repoPath}`),
    });
    return { touched, invocations };
  }

  test("from an indexed worktree, syncs the worktree only", async () => {
    const { main, worktree } = await checkouts();
    await fs.mkdir(path.join(worktree, ".tokensave"), { recursive: true });
    await fs.writeFile(path.join(worktree, ".tokensave", "tokensave.db"), "");

    const { touched, invocations } = await indexFrom(path.join(worktree, "src"), main);

    expect(touched).toEqual([`posture ${worktree}`]);
    expect(invocations).toEqual([{ runner: "tokensave", args: ["sync"] }]);
  });

  test("from the main checkout, syncs it as before", async () => {
    const { main } = await checkouts();

    const { touched, invocations } = await indexFrom(main, main);

    expect(touched).toEqual([`posture ${main}`]);
    expect(invocations).toEqual([{ runner: "tokensave", args: ["sync"] }]);
  });

  test("from an unindexed worktree, initialises it there", async () => {
    const { main, worktree } = await checkouts();

    const { touched, invocations } = await indexFrom(worktree, main);

    expect(touched).toEqual([`exclude ${worktree}`, `posture ${worktree}`]);
    expect(invocations).toEqual([
      { runner: "tokensave", args: ["init", "--no-git-hook"] },
      { runner: "tokensave", args: ["sync"] },
    ]);
  });
});
