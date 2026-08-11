import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { WorkspaceInventoryV1 } from "../../../lib/orchestrator/workspace-inventory";
import { runWorkingCleanupCommand, type WorkingCleanupCommandDeps } from "./cleanup";

const emptyInventory: WorkspaceInventoryV1 = {
  schemaVersion: 1,
  companions: [],
  pairings: [],
};

afterEach(() => {
  process.exitCode = 0;
});

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
    cleanup: async () => ({ changed: true, removed: [".mate", "git-excludes"], updated: [] }),
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
            return { changed: true, removed: [".mate", "git-excludes"], updated: [] };
          },
        }),
      );
    } finally {
      log.mockRestore();
    }

    expect(cleanupCalls).toEqual([{ repoPath: "/repo", companions: ["/companion"] }]);
    expect(logs).toEqual(["mate: cleaned working repository (removed: .mate, git-excludes)"]);
  });

  test("reports idempotent cleanup", async () => {
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => logs.push(line));
    try {
      await runWorkingCleanupCommand(
        [],
        deps({ cleanup: async () => ({ changed: false, removed: [], updated: [] }) }),
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
              return { changed: true, removed: [], updated: [] };
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
