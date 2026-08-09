import { afterEach, describe, expect, mock, test } from "bun:test";

import { createVscodeMock } from "./test-support/vscode-mock";
import { WorkspaceService } from "./workspace-service";

afterEach(() => {
  mock.restore();
});

const READY_PAIRING = {
  companionPath: "/companions/a",
  repository: { id: "app", path: "/repos/app" },
  health: "ready" as const,
  ambiguous: false,
};
const READY_NODE = {
  kind: "pairing" as const,
  pairing: READY_PAIRING,
  contextValue: "pairing",
  description: "x",
};

const UNHEALTHY_PAIRING = {
  companionPath: "/companions/a",
  repository: { id: "other", path: "/repos/gone" },
  health: "missing-repository" as const,
  ambiguous: false,
};
const UNHEALTHY_NODE = {
  kind: "pairing" as const,
  pairing: UNHEALTHY_PAIRING,
  contextValue: "pairing",
  description: "x",
};

/** A WorkspaceService whose `mate workspace materialize --json` call always succeeds with the given result. */
function materializingService(materializeCalls: unknown[][]): WorkspaceService {
  return new WorkspaceService({
    options: () => ({}),
    runMateCli: async (args) => {
      materializeCalls.push(args);
      return {
        code: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          workspacePath: "/repo/.mate/workspace.code-workspace",
          folders: ["/repo", "/companion"],
        }),
        stderr: "",
      };
    },
  });
}

async function setUp() {
  const mockVscode = createVscodeMock();
  mock.module("vscode", () => mockVscode.module);
  const { registerCommands } = await import("./commands");
  const context = { subscriptions: [] as unknown[] };
  return { ...mockVscode, registerCommands, context };
}

describe("mate.openWorkspace", () => {
  test("materializes the pairing and opens the returned workspace in a new window", async () => {
    const { registerCommands, context, calls, registeredCommands } = await setUp();
    const materializeCalls: unknown[][] = [];

    registerCommands(context as never, {
      workspaceService: materializingService(materializeCalls),
      refresh: async () => {},
      isTrusted: () => true,
    });
    await registeredCommands.get("mate.openWorkspace")?.(READY_NODE);

    expect(materializeCalls[0]).toEqual([
      "workspace",
      "materialize",
      "--repository",
      "app",
      "--companion",
      "/companions/a",
      "--json",
    ]);
    expect(calls.executeCommand).toHaveLength(1);
    expect(calls.executeCommand[0]?.[0]).toBe("vscode.openFolder");
    expect(calls.executeCommand[0]?.[2]).toEqual({ forceNewWindow: true });
  });

  test("does nothing for an unhealthy pairing", async () => {
    const { registerCommands, context, calls, registeredCommands } = await setUp();
    const materializeCalls: unknown[][] = [];

    registerCommands(context as never, {
      workspaceService: materializingService(materializeCalls),
      refresh: async () => {},
      isTrusted: () => true,
    });
    await registeredCommands.get("mate.openWorkspace")?.(UNHEALTHY_NODE);

    expect(materializeCalls).toEqual([]);
    expect(calls.executeCommand).toEqual([]);
  });

  test("shows an error and does not open a window when materialization fails", async () => {
    const { registerCommands, context, calls, registeredCommands } = await setUp();
    const service = new WorkspaceService({
      options: () => ({}),
      runMateCli: async () => ({ code: 1, stdout: "", stderr: "mate: pairing not found" }),
    });

    registerCommands(context as never, {
      workspaceService: service,
      refresh: async () => {},
      isTrusted: () => true,
    });
    await registeredCommands.get("mate.openWorkspace")?.(READY_NODE);

    expect(calls.executeCommand).toEqual([]);
    expect(calls.showErrorMessage).toHaveLength(1);
    expect(String(calls.showErrorMessage[0]?.[0])).toContain("pairing not found");
  });
});

describe("mate.revealWorkingRepository / mate.revealCompanion", () => {
  test("reveals the working repository root when it is available", async () => {
    const { registerCommands, context, calls, registeredCommands } = await setUp();
    registerCommands(context as never, {
      workspaceService: materializingService([]),
      refresh: async () => {},
      isTrusted: () => true,
    });

    registeredCommands.get("mate.revealWorkingRepository")?.(READY_NODE);

    expect(calls.executeCommand[0]?.[0]).toBe("revealFileInOS");
  });

  test("does not reveal the working repository when its root is missing", async () => {
    const { registerCommands, context, calls, registeredCommands } = await setUp();
    registerCommands(context as never, {
      workspaceService: materializingService([]),
      refresh: async () => {},
      isTrusted: () => true,
    });

    registeredCommands.get("mate.revealWorkingRepository")?.(UNHEALTHY_NODE);

    expect(calls.executeCommand).toEqual([]);
  });

  test("always reveals the companion, even for a pairing with a missing repository", async () => {
    const { registerCommands, context, calls, registeredCommands } = await setUp();
    registerCommands(context as never, {
      workspaceService: materializingService([]),
      refresh: async () => {},
      isTrusted: () => true,
    });

    registeredCommands.get("mate.revealCompanion")?.(UNHEALTHY_NODE);

    expect(calls.executeCommand[0]?.[0]).toBe("revealFileInOS");
  });
});

describe("mate.copyWorkingRepositoryPath / mate.copyCompanionPath", () => {
  test("copies the working repository path", async () => {
    const { registerCommands, context, calls, registeredCommands } = await setUp();
    registerCommands(context as never, {
      workspaceService: materializingService([]),
      refresh: async () => {},
      isTrusted: () => true,
    });

    registeredCommands.get("mate.copyWorkingRepositoryPath")?.(READY_NODE);

    expect(calls.writeText).toEqual([["/repos/app"]]);
  });

  test("copies the companion path", async () => {
    const { registerCommands, context, calls, registeredCommands } = await setUp();
    registerCommands(context as never, {
      workspaceService: materializingService([]),
      refresh: async () => {},
      isTrusted: () => true,
    });

    registeredCommands.get("mate.copyCompanionPath")?.(READY_NODE);

    expect(calls.writeText).toEqual([["/companions/a"]]);
  });
});

describe("mate.launchOpenCode / mate.launchClaude", () => {
  test("launches an integrated terminal pinned to the pairing for a ready, trusted pairing", async () => {
    const { registerCommands, context, calls, fakeTerminal, registeredCommands } = await setUp();
    registerCommands(context as never, {
      workspaceService: materializingService([]),
      refresh: async () => {},
      isTrusted: () => true,
    });

    registeredCommands.get("mate.launchOpenCode")?.(READY_NODE);

    expect(calls.createTerminal[0]?.[0]).toMatchObject({
      cwd: "/repos/app",
      env: {
        MATE_REPO_PATH: "/repos/app",
        MATE_ARTIFACT_PATH: "/companions/a",
        MATE_REPO_ID: "app",
      },
    });
    expect(fakeTerminal.sendText[0]).toEqual(["mate opencode"]);
  });

  test("refuses to launch for an unhealthy pairing", async () => {
    const { registerCommands, context, calls, registeredCommands } = await setUp();
    registerCommands(context as never, {
      workspaceService: materializingService([]),
      refresh: async () => {},
      isTrusted: () => true,
    });

    registeredCommands.get("mate.launchClaude")?.(UNHEALTHY_NODE);

    expect(calls.createTerminal).toEqual([]);
    expect(calls.showErrorMessage).toHaveLength(1);
  });

  test("refuses to launch in an untrusted window even for a healthy pairing", async () => {
    const { registerCommands, context, calls, registeredCommands } = await setUp();
    registerCommands(context as never, {
      workspaceService: materializingService([]),
      refresh: async () => {},
      isTrusted: () => false,
    });

    registeredCommands.get("mate.launchOpenCode")?.(READY_NODE);

    expect(calls.createTerminal).toEqual([]);
    expect(calls.showErrorMessage).toHaveLength(1);
    expect(String(calls.showErrorMessage[0]?.[0])).toContain("untrusted");
  });
});

describe("mate.refreshWorkspaces", () => {
  test("delegates to the host's refresh", async () => {
    const { registerCommands, context, registeredCommands } = await setUp();
    let refreshed = 0;
    registerCommands(context as never, {
      workspaceService: materializingService([]),
      refresh: async () => {
        refreshed += 1;
      },
      isTrusted: () => true,
    });

    await registeredCommands.get("mate.refreshWorkspaces")?.();

    expect(refreshed).toBe(1);
  });
});
