import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { resetActiveDistribution, setActiveDistribution } from "../../distribution";
import type { CapabilityPlugin, ProviderPlugin } from "../../tools/setup/plugin";
import { PluginRegistry } from "../../tools/setup/registry";
import { LaunchAdapter } from "./adapters/base";
import { CompanionStore } from "./companion-store";
import * as editor from "./editor";
import { FrameworkLauncher, launcherDeps } from "./launcher";
import { CLAUDE_LOCAL_CONFIG_DOCUMENT } from "./projection-runtime-documents";
import type { LaunchContext } from "./framework-context";
import type {
  ProjectionInput,
  ProjectionResult,
  RenderedRuntimeDocument,
} from "./projection-types";
import { LaunchPreflightError, type CapabilityConfig, type LaunchRequest } from "./types";

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

/** `prepare` answers for the launch scope's outcomes, so a stub has to report some. */
function projectedNothing(): ProjectionResult {
  return { root: "/tmp/repo/.mate", scope: "launch", outcomes: [] };
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
    const projectWorkingRepo = mock(async () => projectedNothing());

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
      return projectedNothing();
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
      expect(events).toEqual([
        "git",
        "setup",
        "repo-settings",
        "projection",
        "preflight",
        "adapter",
      ]);

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

  /**
   * The launch scope places the documents `mate wrap` placed, so it has to
   * render them too: an entry handed no render claims nothing about its
   * destination, and the pins a wrap baked in would never move again.
   */
  test("hands the launch scope its own render of the runtime documents", async () => {
    const { launcher } = createLauncher();
    const rendered: RenderedRuntimeDocument[] = [
      {
        path: ".opencode/opencode.json",
        regions: [
          { at: ["plugin"], kind: "list", values: ["@uniqbit/mate-opencode-plugin@0.16.0"] },
        ],
      },
    ];
    const renderRuntimeDocuments = mock(async () => rendered);
    const projectWorkingRepo = mock(async (_input: ProjectionInput) => projectedNothing());
    const syncCompanionFiles = mock(async () => {});

    const originalRenderRuntimeDocuments = launcherDeps.renderRuntimeDocuments;
    const originalProjectWorkingRepo = launcherDeps.projectWorkingRepo;
    const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
    launcherDeps.renderRuntimeDocuments = renderRuntimeDocuments;
    launcherDeps.projectWorkingRepo = projectWorkingRepo;
    launcherDeps.syncCompanionFiles = syncCompanionFiles;

    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
    });

    try {
      await launcher.prepare(makeRequest());
    } finally {
      launcherDeps.renderRuntimeDocuments = originalRenderRuntimeDocuments;
      launcherDeps.projectWorkingRepo = originalProjectWorkingRepo;
      launcherDeps.syncCompanionFiles = originalSyncCompanionFiles;
    }

    /** The same companion, configuration and Working Repository the wrap renders from. */
    expect(renderRuntimeDocuments.mock.calls[0]).toEqual([
      "/tmp/companion",
      expect.objectContaining({ allowedAgents: ["claude"] }),
      "/tmp/repo",
    ]);
    expect(projectWorkingRepo.mock.calls[0]?.[0]?.runtimeDocuments).toBe(rendered);
  });

  /**
   * The render refuses a pass with no Working Repository rather than addressing
   * its local MCP region by the current directory, and every launch now runs
   * it — not just a wrap. So the real dependency runs here, unstubbed: a launch
   * that stopped supplying the repository would fail this test instead of
   * writing servers under a stray key in the user's global configuration.
   */
  test("renders through the real dependency, addressed by the Working Repository", async () => {
    const { launcher } = createLauncher();
    /** A provider has to be registered for the render to reach a Runtime Surface at all. */
    const claude: ProviderPlugin = {
      id: "claude",
      kind: "provider",
      label: "claude",
      description: "",
      defaultSelected: true,
      isEnabled: () => true,
      async apply() {},
      async teardown() {},
    };
    const headroom: CapabilityPlugin = {
      ...makeCapability("headroom"),
      getRuntimeContributions: () => ({
        claude: { mcpServers: [{ name: "headroom", command: "mate", args: ["cap", "headroom"] }] },
      }),
    };
    setActiveDistribution({
      config: { runtime: "bun", version: "1.0.0" },
      registry: new PluginRegistry([claude, headroom]),
    });
    const projectWorkingRepo = mock(async (_input: ProjectionInput) => projectedNothing());
    const syncCompanionFiles = mock(async () => {});

    const originalProjectWorkingRepo = launcherDeps.projectWorkingRepo;
    const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
    launcherDeps.projectWorkingRepo = projectWorkingRepo;
    launcherDeps.syncCompanionFiles = syncCompanionFiles;

    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
    });

    try {
      await launcher.prepare(makeRequest());
    } finally {
      launcherDeps.projectWorkingRepo = originalProjectWorkingRepo;
      launcherDeps.syncCompanionFiles = originalSyncCompanionFiles;
    }

    const documents = projectWorkingRepo.mock.calls[0]?.[0]?.runtimeDocuments ?? [];
    const local = documents.find((document) => document.path === CLAUDE_LOCAL_CONFIG_DOCUMENT);

    expect(local?.regions[0]?.at).toEqual(["projects", path.resolve("/tmp/repo"), "mcpServers"]);
    expect(local?.regions[0]?.at).not.toContain(process.cwd());
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
        const projectWorkingRepo = mock(async () => projectedNothing());
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
    const projectWorkingRepo = mock(async () => projectedNothing());
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

  test("a launch-scope entry that cannot be written fails the launch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-launcher-projection-"));
    const repoPath = path.join(root, "repo");
    const claudeDir = path.join(repoPath, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.chmod(claudeDir, 0o555);

    const { launcher, adapter } = createLauncher();
    const syncCompanionFiles = mock(async () => {});
    const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
    launcherDeps.syncCompanionFiles = syncCompanionFiles;

    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "acme",
      path: repoPath,
    });

    try {
      const failure = await launcher.prepare(makeRequest()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(LaunchPreflightError);
      expect((failure as Error).message).toContain(path.join(".claude", "settings.local.json"));
      expect((failure as Error).message).toContain("acme");
      expect(adapter.validateLaunch).not.toHaveBeenCalled();
    } finally {
      launcherDeps.syncCompanionFiles = originalSyncCompanionFiles;
      await fs.chmod(claudeDir, 0o755);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("a degradable launch-scope failure warns and the launch proceeds", async () => {
    const { launcher, adapter } = createLauncher();
    const syncCompanionFiles = mock(async () => {});
    const projectWorkingRepo = mock(async () => ({
      ...projectedNothing(),
      outcomes: [
        {
          id: "companion-link" as const,
          path: path.join(".mate", "companion"),
          kind: "owned" as const,
          state: "failed" as const,
          error: new Error("EPERM: operation not permitted"),
          degradable: true,
        },
      ],
    }));
    const originalSyncCompanionFiles = launcherDeps.syncCompanionFiles;
    const originalProjectWorkingRepo = launcherDeps.projectWorkingRepo;
    launcherDeps.syncCompanionFiles = syncCompanionFiles;
    launcherDeps.projectWorkingRepo = projectWorkingRepo;
    const warn = spyOn(console, "error").mockImplementation(() => {});

    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "acme",
      path: "/tmp/repo",
    });

    try {
      await expect(launcher.prepare(makeRequest())).resolves.toBeDefined();
      expect(adapter.validateLaunch).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.flat().join("\n")).toContain("EPERM: operation not permitted");
    } finally {
      warn.mockRestore();
      launcherDeps.syncCompanionFiles = originalSyncCompanionFiles;
      launcherDeps.projectWorkingRepo = originalProjectWorkingRepo;
    }
  });
});
