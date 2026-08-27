import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { resetActiveDistribution, setActiveDistribution } from "../../distribution";
import type { CapabilityPlugin } from "../../tools/setup/plugin";
import { PluginRegistry } from "../../tools/setup/registry";
import { LaunchAdapter } from "./adapters/base";
import { CompanionStore } from "./companion-store";
import * as editor from "./editor";
import { FrameworkLauncher, launcherDeps } from "./launcher";
import type { LaunchContext } from "./framework-context";
import type { CapabilityConfig, LaunchRequest } from "./types";

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
  plugins: CapabilityPlugin[] = [],
) {
  setActiveDistribution({
    config: { runtime: "bun", version: "1.0.0" },
    registry: new PluginRegistry(plugins),
  });
  const launcher = new FrameworkLauncher() as FrameworkLauncher & {
    adapters: Map<string, LaunchAdapter>;
    resolveConfig(): Promise<LaunchContext>;
  };
  launcher.adapters = new Map([["claude", adapter]]);
  launcher.resolveConfig = async () =>
    ({
      companionPath: "/tmp/companion",
      repositoryId: "repo",
      configStore: {
        load: async () => ({
          allowedAgents: ["claude"],
          capabilities,
          git,
        }),
      },
      workingRepoStore: {},
    }) as LaunchContext;

  return { adapter, launcher };
}

function makeRequest(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return { tool: "claude", args: ["--print", "hello"], ...overrides };
}

/** Every launch refreshes the Projection Root; tests not about it stub it out. */
const originalRefreshProjectionRoot = launcherDeps.refreshProjectionRoot;
const refreshProjectionRoot = mock(async () => ({ kind: "current" }) as never);

beforeEach(() => {
  refreshProjectionRoot.mockClear();
  launcherDeps.refreshProjectionRoot = refreshProjectionRoot;
});

afterEach(() => {
  launcherDeps.refreshProjectionRoot = originalRefreshProjectionRoot;
  resetActiveDistribution();
  mock.restore();
});

function makeCapability(
  id: string,
  options: {
    enabled?: boolean;
    providerId?: string;
    preflight?: NonNullable<NonNullable<CapabilityPlugin["forProvider"]>[string]["preflight"]>;
  } = {},
): CapabilityPlugin {
  const providerId = options.providerId ?? "claude";
  return {
    id,
    kind: "capability",
    label: id,
    description: "",
    defaultSelected: false,
    isEnabled: () => options.enabled ?? true,
    async apply() {},
    async teardown() {},
    forProvider: {
      [providerId]: {
        async apply() {},
        async teardown() {},
        ...(options.preflight ? { preflight: options.preflight } : {}),
      },
    },
  };
}

describe("FrameworkLauncher", () => {
  test("resolveLaunchPreview is side-effect free", async () => {
    const { launcher, adapter } = createLauncher();
    const syncCompanionGit = mock(async () => {});
    const syncCompanionFiles = mock(async () => {});
    const projectWorkingRepo = mock(async () => {});

    const originalSyncCompanionGit = launcherDeps.syncCompanionGit;
    const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
    const originalProjectWorkingRepo = launcherDeps.projectWorkingRepo;
    launcherDeps.syncCompanionGit = syncCompanionGit;
    launcherDeps.syncCompanionFiles = syncCompanionFiles;
    launcherDeps.projectWorkingRepo = projectWorkingRepo;

    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
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
      launcherDeps.projectWorkingRepo = originalProjectWorkingRepo;
    }

    expect(syncCompanionFiles).not.toHaveBeenCalled();
    expect(syncCompanionGit).not.toHaveBeenCalled();
    expect(projectWorkingRepo).not.toHaveBeenCalled();
    expect(adapter.validateLaunch).not.toHaveBeenCalled();
    expect(adapter.run).not.toHaveBeenCalled();
  });

  test("prepare runs setup before execute and defers adapter run until execute", async () => {
    const events: string[] = [];
    const adapter = new TestAdapter();
    adapter.validateLaunch.mockImplementation(async () => {
      events.push("adapter");
    });
    const capability = makeCapability("headroom", {
      preflight: async () => {
        events.push("preflight");
        return [];
      },
    });
    const { launcher } = createLauncher(adapter, [{ name: "headroom" }], "auto", [capability]);
    const syncCompanionGit = mock(async () => {
      events.push("git");
    });
    const syncCompanionFiles = mock(async () => {
      events.push("setup");
    });
    const projectWorkingRepo = mock(async () => {
      events.push("repo-settings");
    });
    launcherDeps.refreshProjectionRoot = mock(async () => {
      events.push("projection");
      return { kind: "current" } as never;
    });

    const originalSyncCompanionGit = launcherDeps.syncCompanionGit;
    const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
    const originalProjectWorkingRepo = launcherDeps.projectWorkingRepo;
    launcherDeps.syncCompanionGit = syncCompanionGit;
    launcherDeps.syncCompanionFiles = syncCompanionFiles;
    launcherDeps.projectWorkingRepo = projectWorkingRepo;

    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
    });

    try {
      const prepared = await launcher.prepare(makeRequest({ interactiveGit: true }));

      expect(syncCompanionGit).toHaveBeenCalledTimes(1);
      expect(syncCompanionGit).toHaveBeenCalledWith("/tmp/companion", "/tmp/repo", true);
      expect(syncCompanionFiles).toHaveBeenCalledTimes(1);
      expect(projectWorkingRepo).toHaveBeenCalledTimes(1);
      expect(adapter.validateLaunch).toHaveBeenCalledTimes(1);
      expect(adapter.run).not.toHaveBeenCalled();
      expect(events).toEqual(["git", "setup", "repo-settings", "projection", "preflight", "adapter"]);

      await expect(prepared.execute()).resolves.toEqual({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      });
    } finally {
      launcherDeps.syncCompanionGit = originalSyncCompanionGit;
      launcherDeps.syncCompanionFiles = originalSyncCompanionFiles;
      launcherDeps.projectWorkingRepo = originalProjectWorkingRepo;
    }

    expect(adapter.run).toHaveBeenCalledTimes(1);
  });

  test("runs only enabled capability hooks for the selected provider", async () => {
    const enabled = mock(async () => []);
    const disabled = mock(async () => []);
    const otherProvider = mock(async () => []);
    const withoutPreflight = makeCapability("legacy");
    const plugins = [
      makeCapability("enabled", { preflight: enabled }),
      makeCapability("disabled", { enabled: false, preflight: disabled }),
      makeCapability("other-provider", { providerId: "opencode", preflight: otherProvider }),
      withoutPreflight,
    ];
    const { launcher } = createLauncher(new TestAdapter(), [], undefined, plugins);
    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
    });

    await launcher.prepare(makeRequest());

    expect(enabled).toHaveBeenCalledTimes(1);
    expect(enabled.mock.calls[0]?.[0]).toMatchObject({
      companionPath: "/tmp/companion",
      providerId: "claude",
      repository: { id: "repo", path: "/tmp/repo" },
    });
    expect(disabled).not.toHaveBeenCalled();
    expect(otherProvider).not.toHaveBeenCalled();
  });

  test("aggregates capability diagnostics and blocks adapter validation", async () => {
    const { launcher, adapter } = createLauncher(new TestAdapter(), [], undefined, [
      makeCapability("first", { preflight: async () => ["first issue", "second issue"] }),
      makeCapability("second", { preflight: async () => ["third issue"] }),
    ]);
    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
    });

    await expect(launcher.prepare(makeRequest())).rejects.toThrow(
      /first issue[\s\S]*second issue[\s\S]*third issue/,
    );
    expect(adapter.validateLaunch).not.toHaveBeenCalled();
    expect(adapter.run).not.toHaveBeenCalled();
  });

  test("identifies capability and provider when a preflight hook throws", async () => {
    const { launcher, adapter } = createLauncher(new TestAdapter(), [], undefined, [
      makeCapability("broken", {
        preflight: async () => {
          throw new Error("unexpected failure");
        },
      }),
    ]);
    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
    });

    await expect(launcher.prepare(makeRequest())).rejects.toThrow(
      "Capability preflight failed for broken on claude: unexpected failure",
    );
    expect(adapter.validateLaunch).not.toHaveBeenCalled();
  });

  test("does not run Git preflight when Git auto mode is disabled", async () => {
    const { launcher, adapter } = createLauncher();
    const syncCompanionGit = mock(async () => {});
    const syncCompanionFiles = mock(async () => {});
    const originalSyncCompanionGit = launcherDeps.syncCompanionGit;
    const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
    launcherDeps.syncCompanionGit = syncCompanionGit;
    launcherDeps.syncCompanionFiles = syncCompanionFiles;
    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
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
    expect(syncCompanionGit).toHaveBeenCalledWith("/tmp/companion", "/tmp/repo", false);
  });

  test("skipGit bypasses only the Git preflight", async () => {
    const { launcher, adapter } = createLauncher(new TestAdapter(), [{ name: "headroom" }], "auto");
    const syncCompanionGit = mock(async () => {});
    const syncCompanionFiles = mock(async () => {});
    const originalSyncCompanionGit = launcherDeps.syncCompanionGit;
    const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
    launcherDeps.syncCompanionGit = syncCompanionGit;
    launcherDeps.syncCompanionFiles = syncCompanionFiles;
    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
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
        const projectWorkingRepo = mock(async () => {});
        const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
        const originalProjectWorkingRepo = launcherDeps.projectWorkingRepo;
        launcherDeps.syncCompanionFiles = syncCompanionFiles;
        launcherDeps.projectWorkingRepo = projectWorkingRepo;

        spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
          id: "repo",
          path: "/tmp/repo",
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
          launcherDeps.projectWorkingRepo = originalProjectWorkingRepo;
        }

        expect(adapter.run).toHaveBeenCalledTimes(1);
        expect(injectEditorFolder).not.toHaveBeenCalled();
      }
    } finally {
      process.env = originalEnv;
    }
  });

  test("a Working Repository that cannot be written warns and the launch proceeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-launcher-readonly-"));
    const blocker = path.join(root, "not-a-directory");
    await fs.writeFile(blocker, "", "utf8");

    const { launcher, adapter } = createLauncher();
    launcherDeps.refreshProjectionRoot = originalRefreshProjectionRoot;
    const syncCompanionFiles = mock(async () => {});
    const projectWorkingRepo = mock(async () => {});
    const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
    const originalProjectWorkingRepo = launcherDeps.projectWorkingRepo;
    launcherDeps.syncCompanionFiles = syncCompanionFiles;
    launcherDeps.projectWorkingRepo = projectWorkingRepo;
    const warn = spyOn(console, "error").mockImplementation(() => {});

    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "acme",
      path: path.join(blocker, "repo"),
    });

    try {
      await expect(launcher.prepare(makeRequest())).resolves.toBeDefined();
      expect(adapter.validateLaunch).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.flat().join("\n")).toContain("acme");
    } finally {
      warn.mockRestore();
      launcherDeps.syncCompanionFiles = originalSyncCompanionFiles;
      launcherDeps.projectWorkingRepo = originalProjectWorkingRepo;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
