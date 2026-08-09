import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { WorkspaceInventoryV1 } from "../../../lib/orchestrator/workspace-inventory";
import { runWorkspaceListCommand, workspaceListCommandDeps } from "./list";

const originalCollectWorkspaceInventory = workspaceListCommandDeps.collectWorkspaceInventory;

afterEach(() => {
  workspaceListCommandDeps.collectWorkspaceInventory = originalCollectWorkspaceInventory;
  process.exitCode = 0;
});

describe("runWorkspaceListCommand", () => {
  test("requires --json and does not collect inventory otherwise", async () => {
    const collect = () => {
      throw new Error("must not be called without --json");
    };
    workspaceListCommandDeps.collectWorkspaceInventory = collect;

    await runWorkspaceListCommand([]);

    expect(process.exitCode).toBe(1);
  });

  test("prints exactly one JSON document to stdout", async () => {
    const inventory: WorkspaceInventoryV1 = {
      schemaVersion: 1,
      companions: [{ path: "/companions/a", health: "ready" }],
      pairings: [
        {
          companionPath: "/companions/a",
          repository: { id: "app", path: "/repos/app" },
          health: "ready",
          ambiguous: false,
        },
      ],
    };
    workspaceListCommandDeps.collectWorkspaceInventory = async () => inventory;
    const chunks: string[] = [];
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(
      (chunk: unknown, callback?: (error?: Error | null) => void) => {
        chunks.push(String(chunk));
        (typeof callback === "function" ? callback : undefined)?.(null);
        return true;
      },
    );

    try {
      await runWorkspaceListCommand(["--json"]);
    } finally {
      writeSpy.mockRestore();
    }

    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0]!)).toEqual(inventory);
    expect(process.exitCode).toBe(0);
  });
});
