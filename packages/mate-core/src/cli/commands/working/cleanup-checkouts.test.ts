import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createTempDir } from "../../../../../../test/fixtures";
import { addWorktree, initRepo } from "../../../../test/git-checkouts";
import type { WorkingRepoCleanupResult } from "../../../tools/setup/working-repo-cleanup";
import { runWorkingCleanupCommand, type WorkingCleanupCommandDeps } from "./cleanup";

/** `mate working cleanup` in another Checkout of a linked clone (design Decision 7). */

const roots: string[] = [];

afterEach(async () => {
  process.exitCode = 0;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const cleaned: WorkingRepoCleanupResult = {
  changed: true,
  removed: [".mate"],
  updated: [],
  retained: [],
  kept: [],
  warnings: [],
};

async function clone(): Promise<{ root: string; main: string }> {
  const root = await createTempDir("mate-cleanup-checkouts-");
  roots.push(root);
  return { root, main: initRepo(path.join(root, "acme")) };
}

function depsFor(
  checkout: string,
  registered: string,
  cleanups: string[],
  gitCommonDir?: string,
): WorkingCleanupCommandDeps {
  return {
    cwd: checkout,
    resolveGitRoot: async () => checkout,
    localRootKind: async () => "working",
    collectInventory: async () => ({
      schemaVersion: 1,
      companions: [],
      pairings: [
        {
          companionPath: "/companion",
          repository: { id: "acme", path: registered, ...(gitCommonDir ? { gitCommonDir } : {}) },
          health: "ready",
          ambiguous: false,
        },
      ],
    }),
    cleanup: async (repoPath) => {
      cleanups.push(repoPath);
      return cleaned;
    },
  };
}

async function run(deps: WorkingCleanupCommandDeps): Promise<string> {
  const logs: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
  try {
    await runWorkingCleanupCommand([], deps);
  } finally {
    log.mockRestore();
  }
  return logs.join("\n");
}

describe("mate working cleanup in a worktree", () => {
  test("cleans only the worktree and says Mate adopts it again", async () => {
    const { root, main } = await clone();
    const worktree = addWorktree(main, path.join(root, "acme-fix"));
    const cleanups: string[] = [];

    const output = await run(depsFor(worktree, main, cleanups));

    expect(process.exitCode ?? 0).toBe(0);
    expect(cleanups).toEqual([worktree]);
    expect(output).toContain("adopts it again the next time it runs here");
  });

  test("in the Registered Checkout it says nothing about Adoption", async () => {
    const { main } = await clone();
    const cleanups: string[] = [];

    const output = await run(depsFor(main, main, cleanups));

    expect(cleanups).toEqual([main]);
    expect(output).not.toContain("adopts it again");
  });

  test("matches by the recorded clone once the Registered Checkout is gone", async () => {
    const { root, main } = await clone();
    const worktree = addWorktree(main, path.join(root, "acme-fix"));
    const cleanups: string[] = [];
    await fs.rm(worktree, { recursive: true, force: true });

    await run(depsFor(main, worktree, cleanups, path.join(main, ".git")));

    expect(process.exitCode ?? 0).toBe(0);
    expect(cleanups).toEqual([main]);
  });

  test("a separate clone is not matched", async () => {
    const { root, main } = await clone();
    const separate = initRepo(path.join(root, "separate"));
    const cleanups: string[] = [];

    await run(depsFor(separate, main, cleanups));

    expect(process.exitCode).toBe(1);
    expect(cleanups).toEqual([]);
  });
});
