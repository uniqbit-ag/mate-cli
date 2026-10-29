import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { WorkspaceInventoryV1 } from "../../../lib/orchestrator/workspace-inventory";
import type { WorkingRepoCleanupResult } from "../../../tools/setup/working-repo-cleanup";
import { runWorkingCleanupCommand, type WorkingCleanupCommandDeps } from "./cleanup";

const emptyInventory: WorkspaceInventoryV1 = {
  schemaVersion: 1,
  companions: [],
  pairings: [],
};

afterEach(() => {
  process.exitCode = 0;
});

function cleanupResult(
  overrides: Partial<WorkingRepoCleanupResult> = {},
): WorkingRepoCleanupResult {
  return {
    changed: true,
    removed: [],
    updated: [],
    retained: [],
    kept: [],
    warnings: [],
    ...overrides,
  };
}

function deps(overrides: Partial<WorkingCleanupCommandDeps> = {}): WorkingCleanupCommandDeps {
  return {
    cwd: "/repo/src",
    resolveGitRoot: async () => "/repo",
    localRootKind: async () => "working",
    collectInventory: async () => ({
      ...emptyInventory,
      pairings: [
        {
          companionPath: "/companion",
          repository: { id: "app", path: "/repo" },
          health: "ready",
          ambiguous: false,
        },
      ],
    }),
    cleanup: async () => cleanupResult({ removed: [".mate", "git-excludes"] }),
    ...overrides,
  };
}

describe("runWorkingCleanupCommand", () => {
  test("cleans a registered repository resolved from a subdirectory", async () => {
    const cleanupCalls: Array<{ repoPath: string; companions: string[] }> = [];
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => logs.push(line));
    try {
      await runWorkingCleanupCommand(
        [],
        deps({
          cleanup: async (repoPath, companions) => {
            cleanupCalls.push({ repoPath, companions });
            return cleanupResult({ removed: [".mate", "git-excludes"] });
          },
        }),
      );
    } finally {
      log.mockRestore();
    }

    expect(cleanupCalls).toEqual([{ repoPath: "/repo", companions: ["/companion"] }]);
    expect(logs).toEqual(["mate: cleaned working repository (removed: .mate, git-excludes)"]);
  });

  test("names what it kept for another worktree and which one needs it", async () => {
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => logs.push(line));
    try {
      await runWorkingCleanupCommand(
        [],
        deps({
          cleanup: async () =>
            cleanupResult({
              removed: [".mate"],
              kept: [{ label: "git-excludes", keptFor: ["/repo-feature"] }],
            }),
        }),
      );
    } finally {
      log.mockRestore();
    }

    expect(logs).toEqual([
      "mate: cleaned working repository (removed: .mate; kept: git-excludes (still needed by /repo-feature))",
    ]);
  });

  test("passes a removal's warning on to stderr", async () => {
    const errors: string[] = [];
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation((line: string) => errors.push(line));
    try {
      await runWorkingCleanupCommand(
        [],
        deps({
          cleanup: async () =>
            cleanupResult({
              removed: [".mate"],
              warnings: ["untracked files under /repo/openspec are hidden from Git"],
            }),
        }),
      );
    } finally {
      log.mockRestore();
      error.mockRestore();
    }

    expect(errors).toEqual([
      "mate: warning: untracked files under /repo/openspec are hidden from Git",
    ]);
  });

  test("reports idempotent cleanup", async () => {
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => logs.push(line));
    try {
      await runWorkingCleanupCommand(
        [],
        deps({
          cleanup: async () => cleanupResult({ changed: false }),
        }),
      );
    } finally {
      log.mockRestore();
    }
    expect(logs).toEqual(["mate: working repository already clean"]);
  });

  test("rejects non-Git, unregistered, companion, and hub roots without cleanup", async () => {
    for (const testCase of [
      { resolveGitRoot: async () => null },
      { collectInventory: async () => emptyInventory },
      { localRootKind: async () => "companion" as const },
      { localRootKind: async () => "hub" as const },
    ]) {
      let cleaned = false;
      const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        process.exitCode = 0;
        await runWorkingCleanupCommand(
          [],
          deps({
            ...testCase,
            cleanup: async () => {
              cleaned = true;
              return cleanupResult();
            },
          }),
        );
        expect(process.exitCode).toBe(1);
        expect(cleaned).toBe(false);
      } finally {
        stderr.mockRestore();
      }
    }
  });
});
