import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { LaunchAdapter } from "./adapters/base";
import { CompanionStore } from "./companion-store";
import * as editor from "./editor";
import { FrameworkLauncher, launcherDeps } from "./launcher";
import type { LaunchContext } from "./framework-context";
import type { CapabilityConfig, FrameworkConfig, LaunchRequest, LinkedRepository } from "./types";

class TestAdapter extends LaunchAdapter {
  readonly toolName = "claude";
  readonly validateLaunch = mock(async () => {});
  readonly run = mock(async () => ({
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  }));

  buildArgs(): string[] {
    return [];
  }
}

function createLauncher(
  adapter = new TestAdapter(),
  capabilities: CapabilityConfig[] = [{ name: "headroom" }],
  git?: "auto",
  configOverrides: Partial<FrameworkConfig> = {},
  repository?: LinkedRepository,
) {
  const launcher = new FrameworkLauncher();
  (launcher as unknown as { adapters: Map<string, LaunchAdapter> }).adapters = new Map([
    ["claude", adapter],
  ]);
  const config: FrameworkConfig = {
    profiles: {},
    capabilities,
    git,
    ...configOverrides,
  };
  (launcher as unknown as { resolveConfig(): Promise<LaunchContext> }).resolveConfig = async () =>
    ({
      companionPath: "/tmp/companion",
      repositoryId: "repo",
      repository,
      configStore: { load: async () => config },
      workingRepoStore: {},
    }) as LaunchContext;

  return { adapter, launcher };
}

function makeRequest(): LaunchRequest {
  return { tool: "claude", args: ["--print", "hello"] };
}

afterEach(() => {
  mock.restore();
});

describe("FrameworkLauncher", () => {
  test("disallowed Codex launch reconciles stale working-repo state before rejecting", async () => {
    const { launcher } = createLauncher();
    const cleanup = mock(async () => {});
    const original = launcherDeps.syncWorkingRepoCodexState;
    launcherDeps.syncWorkingRepoCodexState = cleanup;
    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
      profile: "default",
    });
    spyOn(CompanionStore.prototype, "resolvePolicy").mockResolvedValue({
      allowedAgents: ["claude"],
    });

    try {
      await expect(launcher.prepare({ tool: "codex", args: [] })).rejects.toThrow(
        /Tool is disallowed/,
      );
    } finally {
      launcherDeps.syncWorkingRepoCodexState = original;
    }
    expect(cleanup).toHaveBeenCalledWith(
      "/tmp/repo",
      "/tmp/companion",
      expect.objectContaining({ profiles: {} }),
      false,
    );
  });

  test("passes the resolved repository profile and overrides to Codex synchronization", async () => {
    const scenarios: Array<{
      name: string;
      profiles: FrameworkConfig["profiles"];
      repository: LinkedRepository;
      allowed: boolean;
    }> = [
      {
        name: "selected profile disallows Codex",
        profiles: {
          default: { name: "default", allowedAgents: ["claude", "codex"] },
          restricted: { name: "restricted", allowedAgents: ["claude"] },
        },
        repository: { id: "repo", path: "/tmp/repo", profile: "restricted" },
        allowed: false,
      },
      {
        name: "repository override disallows Codex",
        profiles: {
          default: { name: "default", allowedAgents: ["claude", "codex"] },
        },
        repository: {
          id: "repo",
          path: "/tmp/repo",
          profile: "default",
          overrides: { allowedAgents: ["claude"] },
        },
        allowed: false,
      },
      {
        name: "selected profile allows Codex",
        profiles: {
          default: { name: "default", allowedAgents: ["claude"] },
          codex: { name: "codex", allowedAgents: ["claude", "codex"] },
        },
        repository: { id: "repo", path: "/tmp/repo", profile: "codex" },
        allowed: true,
      },
      {
        name: "repository override allows Codex",
        profiles: {
          default: { name: "default", allowedAgents: ["claude"] },
        },
        repository: {
          id: "repo",
          path: "/tmp/repo",
          profile: "default",
          overrides: { allowedAgents: ["claude", "codex"] },
        },
        allowed: true,
      },
    ];

    for (const scenario of scenarios) {
      const { launcher } = createLauncher(
        new TestAdapter(),
        [],
        undefined,
        { profiles: scenario.profiles },
        scenario.repository,
      );
      const syncCompanionFiles = mock(async () => {});
      const syncWorkingRepoClaudeSettings = mock(async () => {});
      const syncCodex = mock(async () => {});
      const originals = {
        companionFiles: launcherDeps.syncCompanionFiles,
        claudeSettings: launcherDeps.syncWorkingRepoClaudeSettings,
        codex: launcherDeps.syncWorkingRepoCodexState,
      };
      launcherDeps.syncCompanionFiles = syncCompanionFiles;
      launcherDeps.syncWorkingRepoClaudeSettings = syncWorkingRepoClaudeSettings;
      launcherDeps.syncWorkingRepoCodexState = syncCodex;

      try {
        await launcher.prepare(makeRequest());
      } finally {
        launcherDeps.syncCompanionFiles = originals.companionFiles;
        launcherDeps.syncWorkingRepoClaudeSettings = originals.claudeSettings;
        launcherDeps.syncWorkingRepoCodexState = originals.codex;
      }

      expect(syncCodex).toHaveBeenCalledWith(
        "/tmp/repo",
        "/tmp/companion",
        expect.objectContaining({ profiles: scenario.profiles }),
        scenario.allowed,
      );
    }
  });

  test("resolveLaunchPreview is side-effect free", async () => {
    const { launcher, adapter } = createLauncher();
    const syncCompanionGit = mock(async () => ({
      skipped: false,
      changed: false,
      companionPath: "/tmp/companion",
    }));
    const syncCompanionFiles = mock(async () => {});
    const syncWorkingRepoClaudeSettings = mock(async () => {});

    const originalSyncCompanionGit = launcherDeps.syncCompanionGit;
    const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
    const originalSyncWorkingRepoClaudeSettings = launcherDeps.syncWorkingRepoClaudeSettings;
    launcherDeps.syncCompanionGit = syncCompanionGit;
    launcherDeps.syncCompanionFiles = syncCompanionFiles;
    launcherDeps.syncWorkingRepoClaudeSettings = syncWorkingRepoClaudeSettings;

    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
      profile: "default",
    });
    spyOn(CompanionStore.prototype, "resolvePolicy").mockResolvedValue({
      allowedAgents: ["claude"],
    });

    try {
      await expect(launcher.resolveLaunchPreview(makeRequest())).resolves.toEqual({
        tool: "claude",
        repositoryId: "repo",
        repositoryPath: "/tmp/repo",
        companionPath: "/tmp/companion",
      });
    } finally {
      launcherDeps.syncCompanionGit = originalSyncCompanionGit;
      launcherDeps.syncCompanionFiles = originalSyncCompanionFiles;
      launcherDeps.syncWorkingRepoClaudeSettings = originalSyncWorkingRepoClaudeSettings;
    }

    expect(syncCompanionFiles).not.toHaveBeenCalled();
    expect(syncCompanionGit).not.toHaveBeenCalled();
    expect(syncWorkingRepoClaudeSettings).not.toHaveBeenCalled();
    expect(adapter.validateLaunch).not.toHaveBeenCalled();
    expect(adapter.run).not.toHaveBeenCalled();
  });

  test("prepare runs setup before execute and defers adapter run until execute", async () => {
    const { launcher, adapter } = createLauncher(new TestAdapter(), [{ name: "headroom" }], "auto");
    const events: string[] = [];
    const syncCompanionGit = mock(async () => {
      events.push("git");
      return { skipped: false, changed: false, companionPath: "/tmp/companion" };
    });
    const syncCompanionFiles = mock(async () => {
      events.push("setup");
    });
    const syncWorkingRepoClaudeSettings = mock(async () => {
      events.push("repo-settings");
    });

    const originalSyncCompanionGit = launcherDeps.syncCompanionGit;
    const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
    const originalSyncWorkingRepoClaudeSettings = launcherDeps.syncWorkingRepoClaudeSettings;
    launcherDeps.syncCompanionGit = syncCompanionGit;
    launcherDeps.syncCompanionFiles = syncCompanionFiles;
    launcherDeps.syncWorkingRepoClaudeSettings = syncWorkingRepoClaudeSettings;

    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
      profile: "default",
    });
    spyOn(CompanionStore.prototype, "resolvePolicy").mockResolvedValue({
      allowedAgents: ["claude"],
    });

    try {
      const prepared = await launcher.prepare(makeRequest());

      expect(syncCompanionGit).toHaveBeenCalledTimes(1);
      expect(syncCompanionFiles).toHaveBeenCalledTimes(1);
      expect(syncWorkingRepoClaudeSettings).toHaveBeenCalledTimes(1);
      expect(adapter.validateLaunch).toHaveBeenCalledTimes(1);
      expect(adapter.run).not.toHaveBeenCalled();
      expect(events).toEqual(["git", "setup", "repo-settings"]);

      await expect(prepared.execute()).resolves.toEqual({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      });
    } finally {
      launcherDeps.syncCompanionGit = originalSyncCompanionGit;
      launcherDeps.syncCompanionFiles = originalSyncCompanionFiles;
      launcherDeps.syncWorkingRepoClaudeSettings = originalSyncWorkingRepoClaudeSettings;
    }

    expect(adapter.run).toHaveBeenCalledTimes(1);
  });

  test("does not run Git preflight when Git auto mode is disabled", async () => {
    const { launcher, adapter } = createLauncher();
    const syncCompanionGit = mock(async () => ({
      skipped: false,
      changed: false,
      companionPath: "/tmp/companion",
    }));
    const syncCompanionFiles = mock(async () => {});
    const originalSyncCompanionGit = launcherDeps.syncCompanionGit;
    const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
    launcherDeps.syncCompanionGit = syncCompanionGit;
    launcherDeps.syncCompanionFiles = syncCompanionFiles;
    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
      profile: "default",
    });
    spyOn(CompanionStore.prototype, "resolvePolicy").mockResolvedValue({
      allowedAgents: ["claude"],
    });

    try {
      const prepared = await launcher.prepare(makeRequest());
      expect(syncCompanionGit).not.toHaveBeenCalled();
      expect(syncCompanionFiles).toHaveBeenCalledTimes(1);
      await prepared.execute();
    } finally {
      launcherDeps.syncCompanionGit = originalSyncCompanionGit;
      launcherDeps.syncCompanionFiles = originalSyncCompanionFiles;
    }

    expect(adapter.run).toHaveBeenCalledTimes(1);
  });

  test("failed Git preflight prevents setup and adapter execution", async () => {
    const { launcher, adapter } = createLauncher(new TestAdapter(), [{ name: "headroom" }], "auto");
    const syncCompanionGit = mock(async () => {
      throw new Error("sync failed");
    });
    const syncCompanionFiles = mock(async () => {});
    const originalSyncCompanionGit = launcherDeps.syncCompanionGit;
    const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
    launcherDeps.syncCompanionGit = syncCompanionGit;
    launcherDeps.syncCompanionFiles = syncCompanionFiles;
    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
      profile: "default",
    });
    spyOn(CompanionStore.prototype, "resolvePolicy").mockResolvedValue({
      allowedAgents: ["claude"],
    });

    try {
      await expect(launcher.prepare(makeRequest())).rejects.toThrow("sync failed");
    } finally {
      launcherDeps.syncCompanionGit = originalSyncCompanionGit;
      launcherDeps.syncCompanionFiles = originalSyncCompanionFiles;
    }

    expect(syncCompanionFiles).not.toHaveBeenCalled();
    expect(adapter.validateLaunch).not.toHaveBeenCalled();
    expect(adapter.run).not.toHaveBeenCalled();
  });

  test("skipGit bypasses only the Git preflight", async () => {
    const { launcher, adapter } = createLauncher(new TestAdapter(), [{ name: "headroom" }], "auto");
    const syncCompanionGit = mock(async () => ({
      skipped: false,
      changed: false,
      companionPath: "/tmp/companion",
    }));
    const syncCompanionFiles = mock(async () => {});
    const originalSyncCompanionGit = launcherDeps.syncCompanionGit;
    const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
    launcherDeps.syncCompanionGit = syncCompanionGit;
    launcherDeps.syncCompanionFiles = syncCompanionFiles;
    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
      profile: "default",
    });
    spyOn(CompanionStore.prototype, "resolvePolicy").mockResolvedValue({
      allowedAgents: ["claude"],
    });

    try {
      const prepared = await launcher.prepare({ ...makeRequest(), skipGit: true });
      expect(syncCompanionGit).not.toHaveBeenCalled();
      expect(syncCompanionFiles).toHaveBeenCalledTimes(1);
      await prepared.execute();
    } finally {
      launcherDeps.syncCompanionGit = originalSyncCompanionGit;
      launcherDeps.syncCompanionFiles = originalSyncCompanionFiles;
    }

    expect(adapter.run).toHaveBeenCalledTimes(1);
  });

  test("execute never injects the editor workspace, even inside a VS Code or Cursor session", async () => {
    const envVars = [
      { VSCODE_IPC_HOOK: "/tmp/vscode.sock" },
      { TERM_PROGRAM: "vscode" },
      { TERM_PROGRAM: "cursor" },
      { CURSOR_TRACE_ID: "trace-id" },
    ];

    const injectEditorFolder = spyOn(editor, "injectEditorFolder");
    const originalEnv = { ...process.env };

    try {
      for (const vars of envVars) {
        const { launcher, adapter } = createLauncher();
        const syncCompanionFiles = mock(async () => {});
        const syncWorkingRepoClaudeSettings = mock(async () => {});
        const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
        const originalSyncWorkingRepoClaudeSettings = launcherDeps.syncWorkingRepoClaudeSettings;
        launcherDeps.syncCompanionFiles = syncCompanionFiles;
        launcherDeps.syncWorkingRepoClaudeSettings = syncWorkingRepoClaudeSettings;

        spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
          id: "repo",
          path: "/tmp/repo",
          profile: "default",
        });
        spyOn(CompanionStore.prototype, "resolvePolicy").mockResolvedValue({
          allowedAgents: ["claude"],
        });

        for (const [key, value] of Object.entries(vars)) {
          process.env[key] = value;
        }

        try {
          const prepared = await launcher.prepare(makeRequest());
          await prepared.execute();
        } finally {
          for (const key of Object.keys(vars)) {
            delete process.env[key];
          }
          launcherDeps.syncCompanionFiles = originalSyncCompanionFiles;
          launcherDeps.syncWorkingRepoClaudeSettings = originalSyncWorkingRepoClaudeSettings;
        }

        expect(adapter.run).toHaveBeenCalledTimes(1);
        expect(injectEditorFolder).not.toHaveBeenCalled();
      }
    } finally {
      process.env = originalEnv;
    }
  });
});
