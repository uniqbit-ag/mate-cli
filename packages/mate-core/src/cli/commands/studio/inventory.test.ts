import { describe, expect, test } from "bun:test";

import type { WorkspaceInventoryV1 } from "../../../lib/orchestrator/workspace-inventory";
import { collectStudioInventory } from "./inventory";

function workspaceInventory(): WorkspaceInventoryV1 {
  return {
    schemaVersion: 1,
    companions: [
      { path: "/companions/acme", health: "ready" },
      { path: "/companions/beta", health: "unreadable", diagnostic: "registry.yaml is malformed" },
    ],
    pairings: [
      {
        companionPath: "/companions/acme",
        repository: { id: "acme/storefront", path: "/repos/storefront" },
        health: "ready",
        ambiguous: true,
      },
      {
        companionPath: "/companions/beta",
        repository: { id: "acme/storefront", path: "/repos/storefront" },
        health: "ready",
        ambiguous: true,
      },
    ],
  };
}

describe("collectStudioInventory", () => {
  test("nests each companion's pairings under the companion", async () => {
    const inventory = await collectStudioInventory({
      collectWorkspaceInventory: async () => workspaceInventory(),
    });

    expect(inventory.companions).toEqual([
      {
        path: "/companions/acme",
        health: "ready",
        pairings: [
          {
            repositoryId: "acme/storefront",
            repositoryPath: "/repos/storefront",
            health: "ready",
            ambiguous: true,
          },
        ],
      },
      {
        path: "/companions/beta",
        health: "unreadable",
        diagnostic: "registry.yaml is malformed",
        pairings: [
          {
            repositoryId: "acme/storefront",
            repositoryPath: "/repos/storefront",
            health: "ready",
            ambiguous: true,
          },
        ],
      },
    ]);
  });

  test("reuses the workspace inventory rather than reading the registry", async () => {
    let calls = 0;
    await collectStudioInventory({
      collectWorkspaceInventory: async () => {
        calls++;
        return workspaceInventory();
      },
    });

    expect(calls).toBe(1);
  });

  test("returns an empty inventory when nothing is registered", async () => {
    const inventory = await collectStudioInventory({
      collectWorkspaceInventory: async () => ({
        schemaVersion: 1,
        companions: [],
        pairings: [],
      }),
    });

    expect(inventory).toEqual({ companions: [] });
  });

  test("keeps a companion with no pairings selectable", async () => {
    const inventory = await collectStudioInventory({
      collectWorkspaceInventory: async () => ({
        schemaVersion: 1,
        companions: [{ path: "/companions/acme", health: "missing" }],
        pairings: [],
      }),
    });

    expect(inventory.companions).toEqual([
      { path: "/companions/acme", health: "missing", pairings: [] },
    ]);
  });
});
