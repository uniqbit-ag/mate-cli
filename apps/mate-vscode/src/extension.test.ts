import { afterEach, describe, expect, mock, test } from "bun:test";

import { MateCliUnavailableError } from "./mate-cli-client";
import { createVscodeMock } from "./test-support/vscode-mock";
import { WorkspaceService } from "./workspace-service";

afterEach(() => {
  mock.restore();
});

function unavailableService(): WorkspaceService {
  return new WorkspaceService({
    options: () => ({}),
    runMateCli: async () => {
      throw new MateCliUnavailableError("not found");
    },
  });
}

function readyService(): WorkspaceService {
  return new WorkspaceService({
    options: () => ({}),
    runMateCli: async (args) => {
      if (args[0] === "--version") return { code: 0, stdout: "0.1.0", stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify({
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
        }),
        stderr: "",
      };
    },
  });
}

function erroringService(): WorkspaceService {
  return new WorkspaceService({
    options: () => ({}),
    runMateCli: async (args) => {
      if (args[0] === "--version") return { code: 0, stdout: "0.1.0", stderr: "" };
      return { code: 1, stdout: "", stderr: "mate: registry is corrupt" };
    },
  });
}

async function activateWithMock(workspaceService: WorkspaceService) {
  const mockVscode = createVscodeMock();
  mock.module("vscode", () => mockVscode.module);
  const { activate } = await import("./extension");
  const context = { subscriptions: [] as Array<{ dispose: () => void }> };
  activate(context as never, { workspaceService });
  // activate() kicks off refresh() without awaiting it; flush microtasks.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { ...mockVscode, context };
}

describe("activate", () => {
  test("registers both tree data providers", async () => {
    const { context } = await activateWithMock(readyService());

    expect(context.subscriptions.length).toBeGreaterThan(0);
  });

  test("registers every mate.* command", async () => {
    const { registeredCommands } = await activateWithMock(readyService());

    for (const command of [
      "mate.refreshWorkspaces",
      "mate.openWorkspace",
      "mate.revealWorkingRepository",
      "mate.revealCompanion",
      "mate.copyWorkingRepositoryPath",
      "mate.copyCompanionPath",
      "mate.launchOpenCode",
      "mate.launchClaude",
    ]) {
      expect(registeredCommands.has(command)).toBe(true);
    }
  });

  test("shows an unavailable state when mate cannot be spawned, without an error toast", async () => {
    const { calls } = await activateWithMock(unavailableService());

    expect(calls.showErrorMessage).toEqual([]);
  });

  test("shows an error toast when mate is available but the inventory call fails", async () => {
    const { calls } = await activateWithMock(erroringService());

    expect(calls.showErrorMessage).toHaveLength(1);
    expect(String(calls.showErrorMessage[0]?.[0])).toContain("registry is corrupt");
  });

  test("mate.refreshWorkspaces re-fetches the inventory", async () => {
    let fetches = 0;
    const service = new WorkspaceService({
      options: () => ({}),
      runMateCli: async (args) => {
        if (args[0] === "--version") return { code: 0, stdout: "0.1.0", stderr: "" };
        fetches += 1;
        return {
          code: 0,
          stdout: JSON.stringify({ schemaVersion: 1, companions: [], pairings: [] }),
          stderr: "",
        };
      },
    });
    const { registeredCommands } = await activateWithMock(service);
    const initialFetches = fetches;

    await registeredCommands.get("mate.refreshWorkspaces")?.();

    expect(fetches).toBe(initialFetches + 1);
  });
});
