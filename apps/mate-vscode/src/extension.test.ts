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

/** Never spawns the real `openspec` binary: an always-empty change list, for tests that don't care about it. */
async function noopOpenSpecService() {
  const { OpenSpecService } = await import("./openspec-service");
  return new OpenSpecService({
    options: () => ({}),
    runOpenSpecCli: async (args) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.0.0", stderr: "" };
      return { code: 0, stdout: JSON.stringify({ changes: [] }), stderr: "" };
    },
  });
}

/** Never spawns the real `mate doctor`: reports no findings, for tests that don't care about it. */
async function noopDoctorDiagnostics(
  runMateCli?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
) {
  const { DoctorDiagnostics } = await import("./doctor-diagnostics");
  return new DoctorDiagnostics({
    options: () => ({}),
    runMateCli: runMateCli ?? (async () => ({ code: 0, stdout: JSON.stringify({}), stderr: "" })),
  });
}

async function activateWithMock(
  workspaceService: WorkspaceService,
  extra: {
    openSpecService?: Awaited<ReturnType<typeof noopOpenSpecService>>;
    doctorDiagnostics?: Awaited<ReturnType<typeof noopDoctorDiagnostics>>;
    workspaceFolderPaths?: string[];
  } = {},
) {
  const mockVscode = createVscodeMock();
  if (extra.workspaceFolderPaths) {
    mockVscode.workspaceFolders.value = extra.workspaceFolderPaths.map((fsPath) => ({
      uri: { fsPath },
    }));
  }
  mock.module("vscode", () => mockVscode.module);
  const { activate } = await import("./extension");
  const context = { subscriptions: [] as Array<{ dispose: () => void }> };
  activate(context as never, {
    workspaceService,
    openSpecService: extra.openSpecService ?? (await noopOpenSpecService()),
    doctorDiagnostics: extra.doctorDiagnostics ?? (await noopDoctorDiagnostics()),
  });
  // activate() kicks off refresh() without awaiting it; flush microtasks.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { ...mockVscode, context };
}

describe("activate", () => {
  test("registers both tree data providers plus the Active Changes view", async () => {
    const { context, treeViews } = await activateWithMock(readyService());

    expect(context.subscriptions.length).toBeGreaterThan(0);
    expect(treeViews.has("mateWorkspaces")).toBe(true);
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
      "mate.attachCompanionToWorkspace",
      "mate.revealPairingFromStatusBar",
      "mate.quickOpenWorkspace",
      "mate.quickLaunchOpenCode",
      "mate.quickLaunchClaude",
      "mate.quickRevealWorkingRepository",
      "mate.quickRevealCompanion",
      "mate.quickCopyWorkingRepositoryPath",
      "mate.quickCopyCompanionPath",
      "mate.openOpenSpecChange",
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

  test("mate.refreshWorkspaces also re-fetches OpenSpec changes and mate doctor diagnostics", async () => {
    let openSpecCalls = 0;
    let doctorCalls = 0;
    const { OpenSpecService } = await import("./openspec-service");
    const openSpecService = new OpenSpecService({
      options: () => ({}),
      runOpenSpecCli: async (args) => {
        if (args[0] === "--version") return { code: 0, stdout: "1.0.0", stderr: "" };
        openSpecCalls += 1;
        return { code: 0, stdout: JSON.stringify({ changes: [] }), stderr: "" };
      },
    });
    const doctorDiagnostics = await noopDoctorDiagnostics(async () => {
      doctorCalls += 1;
      return { code: 0, stdout: JSON.stringify({}), stderr: "" };
    });
    const { registeredCommands } = await activateWithMock(readyService(), {
      openSpecService,
      doctorDiagnostics,
    });
    const [initialOpenSpecCalls, initialDoctorCalls] = [openSpecCalls, doctorCalls];

    await registeredCommands.get("mate.refreshWorkspaces")?.();

    expect(openSpecCalls).toBe(initialOpenSpecCalls + 1);
    expect(doctorCalls).toBe(initialDoctorCalls + 1);
  });

  test("fetches OpenSpec changes with cwd set to each companion's own path, not the extension host's default cwd", async () => {
    const cwds: unknown[] = [];
    const { OpenSpecService } = await import("./openspec-service");
    const openSpecService = new OpenSpecService({
      options: () => ({}),
      runOpenSpecCli: async (args, options) => {
        if (args[0] === "--version") return { code: 0, stdout: "1.0.0", stderr: "" };
        cwds.push(options.cwd);
        return { code: 0, stdout: JSON.stringify({ changes: [] }), stderr: "" };
      },
    });

    await activateWithMock(readyService(), { openSpecService });

    expect(cwds).toEqual(["/companions/a"]);
  });

  test("mate.openOpenSpecChange opens the change's proposal.md via OpenSpecService.getChangeRoot", async () => {
    const { OpenSpecService } = await import("./openspec-service");
    const openSpecService = new OpenSpecService({
      options: () => ({}),
      runOpenSpecCli: async (args) => {
        if (args[0] === "--version") return { code: 0, stdout: "1.0.0", stderr: "" };
        if (args[0] === "status") {
          return {
            code: 0,
            stdout: JSON.stringify({ changeRoot: "/companions/a/openspec/changes/add-foo" }),
            stderr: "",
          };
        }
        return { code: 0, stdout: JSON.stringify({ changes: [] }), stderr: "" };
      },
    });
    const { registeredCommands, calls } = await activateWithMock(readyService(), {
      openSpecService,
    });

    await registeredCommands.get("mate.openOpenSpecChange")?.({
      name: "add-foo",
      companionPath: "/companions/a",
    });

    expect(calls.showTextDocument).toHaveLength(1);
  });

  test("clicking the status bar item reveals the matched pairing's tree item", async () => {
    const { registeredCommands, treeViews } = await activateWithMock(readyService(), {
      workspaceFolderPaths: ["/repos/app"],
    });
    const workspacesReveal = treeViews.get("mateWorkspaces")?.reveal ?? [];

    await registeredCommands.get("mate.revealPairingFromStatusBar")?.();

    expect(workspacesReveal).toHaveLength(1);
  });
});
