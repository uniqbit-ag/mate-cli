import { describe, expect, test } from "bun:test";

import { collectWorkspaceInventory, type WorkspaceInventoryDeps } from "./workspace-inventory";

function makeDeps(overrides: Partial<WorkspaceInventoryDeps> = {}): WorkspaceInventoryDeps {
  return {
    listCompanionPaths: async () => [],
    isDirectory: async () => true,
    readCompanionRegistry: async () => ({ repos: [] }),
    ...overrides,
  };
}

describe("collectWorkspaceInventory", () => {
  test("emits a ready companion and ready pairing when every root exists", async () => {
    const deps = makeDeps({
      listCompanionPaths: async () => ["/companions/a"],
      readCompanionRegistry: async () => ({ repos: [{ id: "app", path: "/repos/app" }] }),
    });

    const inventory = await collectWorkspaceInventory(deps);

    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.companions).toEqual([{ path: "/companions/a", health: "ready" }]);
    expect(inventory.pairings).toEqual([
      {
        companionPath: "/companions/a",
        repository: { id: "app", path: "/repos/app" },
        health: "ready",
        ambiguous: false,
      },
    ]);
  });

  test("marks a companion missing when its directory does not exist, with no pairings", async () => {
    const deps = makeDeps({
      listCompanionPaths: async () => ["/companions/gone"],
      isDirectory: async () => false,
      readCompanionRegistry: async () => {
        throw new Error("should not be called for a missing companion directory");
      },
    });

    const inventory = await collectWorkspaceInventory(deps);

    expect(inventory.companions).toEqual([{ path: "/companions/gone", health: "missing" }]);
    expect(inventory.pairings).toEqual([]);
  });

  test("marks a pairing missing-repository when the linked repo path does not exist", async () => {
    const deps = makeDeps({
      listCompanionPaths: async () => ["/companions/a"],
      isDirectory: async (candidate) => candidate === "/companions/a",
      readCompanionRegistry: async () => ({ repos: [{ id: "app", path: "/repos/gone" }] }),
    });

    const inventory = await collectWorkspaceInventory(deps);

    expect(inventory.pairings).toEqual([
      {
        companionPath: "/companions/a",
        repository: { id: "app", path: "/repos/gone" },
        health: "missing-repository",
        ambiguous: false,
      },
    ]);
  });

  test("marks a companion unreadable with a diagnostic and still returns other companions", async () => {
    const deps = makeDeps({
      listCompanionPaths: async () => ["/companions/bad", "/companions/good"],
      readCompanionRegistry: async (companionPath) => {
        if (companionPath === "/companions/bad") throw new Error("invalid YAML");
        return { repos: [{ id: "app", path: "/repos/app" }] };
      },
    });

    const inventory = await collectWorkspaceInventory(deps);

    expect(inventory.companions).toEqual([
      { path: "/companions/bad", health: "unreadable", diagnostic: "invalid YAML" },
      { path: "/companions/good", health: "ready" },
    ]);
    expect(inventory.pairings).toEqual([
      {
        companionPath: "/companions/good",
        repository: { id: "app", path: "/repos/app" },
        health: "ready",
        ambiguous: false,
      },
    ]);
  });

  test("treats a missing registry.yaml (ENOENT) as a ready, unlinked companion", async () => {
    const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
    const deps = makeDeps({
      listCompanionPaths: async () => ["/companions/fresh"],
      readCompanionRegistry: async () => {
        throw enoent;
      },
    });

    const inventory = await collectWorkspaceInventory(deps);

    expect(inventory.companions).toEqual([{ path: "/companions/fresh", health: "ready" }]);
    expect(inventory.pairings).toEqual([]);
  });

  test("flags pairings as ambiguous when the same repository path is linked from multiple companions", async () => {
    const deps = makeDeps({
      listCompanionPaths: async () => ["/companions/a", "/companions/b"],
      readCompanionRegistry: async (companionPath) => ({
        repos: [{ id: "app", path: "/repos/app" }],
      }),
    });

    const inventory = await collectWorkspaceInventory(deps);

    expect(inventory.pairings).toHaveLength(2);
    expect(inventory.pairings.every((pairing) => pairing.ambiguous)).toBe(true);
  });

  test("orders companions and pairings deterministically regardless of input order", async () => {
    const deps = makeDeps({
      listCompanionPaths: async () => ["/companions/b", "/companions/a"],
      readCompanionRegistry: async (companionPath) => ({
        repos:
          companionPath === "/companions/a"
            ? [
                { id: "z-repo", path: "/repos/z" },
                { id: "a-repo", path: "/repos/a" },
              ]
            : [],
      }),
    });

    const inventory = await collectWorkspaceInventory(deps);

    expect(inventory.companions.map((c) => c.path)).toEqual(["/companions/a", "/companions/b"]);
    expect(inventory.pairings.map((p) => p.repository.id)).toEqual(["a-repo", "z-repo"]);
  });

  test("deduplicates repeated companion paths from the global registry", async () => {
    const deps = makeDeps({
      listCompanionPaths: async () => ["/companions/a", "/companions/a"],
      readCompanionRegistry: async () => ({ repos: [] }),
    });

    const inventory = await collectWorkspaceInventory(deps);

    expect(inventory.companions).toHaveLength(1);
  });
});
