import { afterEach, describe, expect, mock, test } from "bun:test";

import { buildPairingSnapshot } from "./pairing-snapshot";
import { createVscodeMock } from "./test-support/vscode-mock";
import { WorkspaceService } from "./workspace-service";

afterEach(() => {
  mock.restore();
});

/** A WorkspaceService whose `mate workspace materialize --json` call always succeeds. */
function materializingService(): WorkspaceService {
  return new WorkspaceService({
    options: () => ({}),
    runMateCli: async () => ({
      code: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        workspacePath: "/repo/.mate/workspace.code-workspace",
        folders: ["/repo", "/companion"],
      }),
      stderr: "",
    }),
  });
}

const READY_PAIRING = {
  companionPath: "/companions/a",
  repository: { id: "app", path: "/repos/app" },
  health: "ready" as const,
  ambiguous: false,
};
const UNHEALTHY_PAIRING = {
  companionPath: "/companions/b",
  repository: { id: "other", path: "/repos/gone" },
  health: "missing-repository" as const,
  ambiguous: false,
};

const SNAPSHOT = buildPairingSnapshot({
  schemaVersion: 1,
  companions: [
    { path: "/companions/a", health: "ready" },
    { path: "/companions/b", health: "ready" },
  ],
  pairings: [READY_PAIRING, UNHEALTHY_PAIRING],
});

async function setUp() {
  const mockVscode = createVscodeMock();
  mock.module("vscode", () => mockVscode.module);
  const { registerQuickPickCommands } = await import("./quick-pick-actions");
  const context = { subscriptions: [] as unknown[] };
  return { ...mockVscode, registerQuickPickCommands, context };
}

describe("mate.quickOpenWorkspace", () => {
  test("presents only openable pairings and opens the one selected", async () => {
    const { registerQuickPickCommands, context, calls, registeredCommands, quickPickResult } =
      await setUp();
    registerQuickPickCommands(context as never, {
      workspaceService: materializingService(),
      refresh: async () => {},
      isTrusted: () => true,
      getState: () => ({ status: "ready", snapshot: SNAPSHOT }),
    });

    quickPickResult.value = { pairing: READY_PAIRING };
    await registeredCommands.get("mate.quickOpenWorkspace")?.();

    expect(calls.showQuickPick[0]?.[0]).toEqual([
      { label: "app", description: "/companions/a", pairing: READY_PAIRING },
    ]);
    expect(calls.executeCommand[0]?.[0]).toBe("vscode.openFolder");
  });

  test("shows an empty quick-pick state when no pairing is openable", async () => {
    const { registerQuickPickCommands, context, calls, registeredCommands } = await setUp();
    registerQuickPickCommands(context as never, {
      workspaceService: materializingService(),
      refresh: async () => {},
      isTrusted: () => true,
      getState: () => ({
        status: "ready",
        snapshot: buildPairingSnapshot({
          schemaVersion: 1,
          companions: [],
          pairings: [UNHEALTHY_PAIRING],
        }),
      }),
    });

    await registeredCommands.get("mate.quickOpenWorkspace")?.();

    expect(calls.showQuickPick[0]?.[0]).toEqual([]);
    expect(calls.executeCommand).toEqual([]);
  });

  test("does nothing when the user dismisses the quick pick", async () => {
    const { registerQuickPickCommands, context, calls, registeredCommands } = await setUp();
    registerQuickPickCommands(context as never, {
      workspaceService: materializingService(),
      refresh: async () => {},
      isTrusted: () => true,
      getState: () => ({ status: "ready", snapshot: SNAPSHOT }),
    });

    await registeredCommands.get("mate.quickOpenWorkspace")?.();

    expect(calls.executeCommand).toEqual([]);
  });
});

describe("mate.quickLaunchOpenCode", () => {
  test("filters to launchable pairings only, respecting trust", async () => {
    const { registerQuickPickCommands, context, calls, registeredCommands } = await setUp();
    registerQuickPickCommands(context as never, {
      workspaceService: materializingService(),
      refresh: async () => {},
      isTrusted: () => false,
      getState: () => ({ status: "ready", snapshot: SNAPSHOT }),
    });

    await registeredCommands.get("mate.quickLaunchOpenCode")?.();

    expect(calls.showQuickPick[0]?.[0]).toEqual([]);
  });

  test("launches the selected pairing when trusted and healthy", async () => {
    const { registerQuickPickCommands, context, calls, registeredCommands, quickPickResult } =
      await setUp();
    registerQuickPickCommands(context as never, {
      workspaceService: materializingService(),
      refresh: async () => {},
      isTrusted: () => true,
      getState: () => ({ status: "ready", snapshot: SNAPSHOT }),
    });

    quickPickResult.value = { pairing: READY_PAIRING };
    await registeredCommands.get("mate.quickLaunchOpenCode")?.();

    expect(calls.createTerminal).toHaveLength(1);
  });
});

describe("mate.quickCopyCompanionPath", () => {
  test("offers every pairing regardless of health", async () => {
    const { registerQuickPickCommands, context, calls, registeredCommands, quickPickResult } =
      await setUp();
    registerQuickPickCommands(context as never, {
      workspaceService: materializingService(),
      refresh: async () => {},
      isTrusted: () => true,
      getState: () => ({ status: "ready", snapshot: SNAPSHOT }),
    });

    expect(calls.showQuickPick).toEqual([]);
    quickPickResult.value = { pairing: UNHEALTHY_PAIRING };
    await registeredCommands.get("mate.quickCopyCompanionPath")?.();

    expect((calls.showQuickPick[0]?.[0] as unknown[]).length).toBe(2);
    expect(calls.writeText).toEqual([["/companions/b"]]);
  });
});
