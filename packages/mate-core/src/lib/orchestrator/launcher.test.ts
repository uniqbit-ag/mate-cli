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
import type { ProjectionInput, ProjectionResult } from "./projection-types";
import { sessionPrepareDeps } from "./session-prepare";
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
  capabilities: CapabilityConfig[] = [{ name: "tokensave" }],
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
      launchWorkingDirectory: "/tmp/repo",
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
const originalRefreshProjectionRoot = sessionPrepareDeps.refreshProjectionRoot;
const refreshProjectionRoot = mock(async () => ({ kind: "current" }) as never);

/**
 * Every launch first asks whether the repository is wrapped. Stubbed rather
 * than left to read the real `/tmp/repo`, so the suite cannot be decided by a
 * directory that happens to exist on the machine running it.
 */
const originalIsWrapped = sessionPrepareDeps.isWrapped;
const isWrapped = mock(async () => false);
const originalIsInteractiveTerminal = sessionPrepareDeps.isInteractiveTerminal;

beforeEach(() => {
  refreshProjectionRoot.mockClear();
  sessionPrepareDeps.refreshProjectionRoot = refreshProjectionRoot;
  isWrapped.mockClear();
  isWrapped.mockResolvedValue(false);
  sessionPrepareDeps.isWrapped = isWrapped;
  sessionPrepareDeps.isInteractiveTerminal = () => false;
});

afterEach(() => {
  sessionPrepareDeps.refreshProjectionRoot = originalRefreshProjectionRoot;
  sessionPrepareDeps.isWrapped = originalIsWrapped;
  sessionPrepareDeps.isInteractiveTerminal = originalIsInteractiveTerminal;
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

    const originalSyncCompanionGit = sessionPrepareDeps.syncCompanionGit;
    const originalSyncCompanionFiles = sessionPrepareDeps.syncCompanionFiles;
    const originalProjectWorkingRepo = sessionPrepareDeps.projectLaunch;
    sessionPrepareDeps.syncCompanionGit = syncCompanionGit;
    sessionPrepareDeps.syncCompanionFiles = syncCompanionFiles;
    sessionPrepareDeps.projectLaunch = projectWorkingRepo;

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
      sessionPrepareDeps.syncCompanionGit = originalSyncCompanionGit;
      sessionPrepareDeps.syncCompanionFiles = originalSyncCompanionFiles;
      sessionPrepareDeps.projectLaunch = originalProjectWorkingRepo;
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
    const capability = makeCapability("tokensave", {
      preflight: async () => {
        events.push("preflight");
        return [];
      },
    });
    const { launcher } = createLauncher(adapter, [{ name: "tokensave" }], "auto", [capability]);
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
    sessionPrepareDeps.refreshProjectionRoot = mock(async () => {
      events.push("projection");
      return { kind: "current" } as never;
    });

    const originalSyncCompanionGit = sessionPrepareDeps.syncCompanionGit;
    const originalSyncCompanionFiles = sessionPrepareDeps.syncCompanionFiles;
    const originalProjectWorkingRepo = sessionPrepareDeps.projectLaunch;
    sessionPrepareDeps.syncCompanionGit = syncCompanionGit;
    sessionPrepareDeps.syncCompanionFiles = syncCompanionFiles;
    sessionPrepareDeps.projectLaunch = projectWorkingRepo;

    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
    });

    try {
      sessionPrepareDeps.isInteractiveTerminal = () => true;
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
      sessionPrepareDeps.syncCompanionGit = originalSyncCompanionGit;
      sessionPrepareDeps.syncCompanionFiles = originalSyncCompanionFiles;
      sessionPrepareDeps.projectLaunch = originalProjectWorkingRepo;
    }

    expect(adapter.run).toHaveBeenCalledTimes(1);
  });

  test("companion scope skips repository work but keeps companion preflight", async () => {
    const adapter = new TestAdapter();
    const capabilityPreflight = mock(async () => []);
    const { launcher } = createLauncher(adapter, [], "auto", [
      makeCapability("companion-capability", { preflight: capabilityPreflight }),
    ]);
    const syncCompanionGit = mock(async () => {});
    const syncCompanionFiles = mock(async () => {});
    const originalSyncCompanionGit = sessionPrepareDeps.syncCompanionGit;
    const originalSyncCompanionFiles = sessionPrepareDeps.syncCompanionFiles;
    sessionPrepareDeps.syncCompanionGit = syncCompanionGit;
    sessionPrepareDeps.syncCompanionFiles = syncCompanionFiles;

    try {
      await launcher.prepare(makeRequest({ scope: "companion" }));
    } finally {
      sessionPrepareDeps.syncCompanionGit = originalSyncCompanionGit;
      sessionPrepareDeps.syncCompanionFiles = originalSyncCompanionFiles;
    }

    expect(isWrapped).not.toHaveBeenCalled();
    expect(syncCompanionGit).toHaveBeenCalledWith("/tmp/companion", undefined, false);
    expect(syncCompanionFiles).toHaveBeenCalledWith(
      "/tmp/companion",
      expect.objectContaining({ allowedAgents: ["claude"] }),
    );
    expect(refreshProjectionRoot).not.toHaveBeenCalled();
    expect(capabilityPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ companionPath: "/tmp/companion", repository: undefined }),
    );
    expect(adapter.validateLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        companionPath: "/tmp/companion",
        launchWorkingDirectory: "/tmp/companion",
        repository: undefined,
      }),
    );
  });

  /**
   * The inverse of what a wrap does, and the reason the two commands cannot
   * collide: the launch scope declares the runtime document entries so
   * `mate working cleanup` reaches them, but hands them no render. An entry
   * given no render claims nothing about its destination, so a launch cannot
   * create one — and only `mate wrap` ever places a document in a Working
   * Repository.
   */
  test("hands the launch scope no render, so it can place no runtime document", async () => {
    const { launcher } = createLauncher();
    const projectWorkingRepo = mock(async (_input: ProjectionInput) => projectedNothing());
    const syncCompanionFiles = mock(async () => {});

    const originalProjectWorkingRepo = sessionPrepareDeps.projectLaunch;
    const originalSyncCompanionFiles = sessionPrepareDeps.syncCompanionFiles;
    sessionPrepareDeps.projectLaunch = projectWorkingRepo;
    sessionPrepareDeps.syncCompanionFiles = syncCompanionFiles;

    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
    });

    try {
      await launcher.prepare(makeRequest());
    } finally {
      sessionPrepareDeps.projectLaunch = originalProjectWorkingRepo;
      sessionPrepareDeps.syncCompanionFiles = originalSyncCompanionFiles;
    }

    const input = projectWorkingRepo.mock.calls[0]?.[0];
    expect(input?.runtimeDocuments).toBeUndefined();
    /** And the launch scope is still what writes the rest of the working repo. */
    expect(input?.repoPath).toBe("/tmp/repo");
    expect(input?.companionPath).toBe("/tmp/companion");
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
    const originalSyncCompanionGit = sessionPrepareDeps.syncCompanionGit;
    const originalSyncCompanionFiles = sessionPrepareDeps.syncCompanionFiles;
    sessionPrepareDeps.syncCompanionGit = syncCompanionGit;
    sessionPrepareDeps.syncCompanionFiles = syncCompanionFiles;
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
      sessionPrepareDeps.syncCompanionGit = originalSyncCompanionGit;
      sessionPrepareDeps.syncCompanionFiles = originalSyncCompanionFiles;
    }

    expect(adapter.run).toHaveBeenCalledTimes(1);
  });

  test("failed Git preflight prevents setup and adapter execution", async () => {
    const { launcher, adapter } = createLauncher(
      new TestAdapter(),
      [{ name: "tokensave" }],
      "auto",
    );
    const syncCompanionGit = mock(async () => {
      throw new Error("sync failed");
    });
    const syncCompanionFiles = mock(async () => {});
    const originalSyncCompanionGit = sessionPrepareDeps.syncCompanionGit;
    const originalSyncCompanionFiles = sessionPrepareDeps.syncCompanionFiles;
    sessionPrepareDeps.syncCompanionGit = syncCompanionGit;
    sessionPrepareDeps.syncCompanionFiles = syncCompanionFiles;
    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
    });

    try {
      await expect(launcher.prepare(makeRequest())).rejects.toThrow("sync failed");
    } finally {
      sessionPrepareDeps.syncCompanionGit = originalSyncCompanionGit;
      sessionPrepareDeps.syncCompanionFiles = originalSyncCompanionFiles;
    }

    expect(syncCompanionFiles).not.toHaveBeenCalled();
    expect(adapter.validateLaunch).not.toHaveBeenCalled();
    expect(adapter.run).not.toHaveBeenCalled();
    expect(syncCompanionGit).toHaveBeenCalledWith("/tmp/companion", "/tmp/repo", false);
  });

  test("skipGit bypasses only the Git preflight", async () => {
    const { launcher, adapter } = createLauncher(
      new TestAdapter(),
      [{ name: "tokensave" }],
      "auto",
    );
    const syncCompanionGit = mock(async () => {});
    const syncCompanionFiles = mock(async () => {});
    const originalSyncCompanionGit = sessionPrepareDeps.syncCompanionGit;
    const originalSyncCompanionFiles = sessionPrepareDeps.syncCompanionFiles;
    sessionPrepareDeps.syncCompanionGit = syncCompanionGit;
    sessionPrepareDeps.syncCompanionFiles = syncCompanionFiles;
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
      sessionPrepareDeps.syncCompanionGit = originalSyncCompanionGit;
      sessionPrepareDeps.syncCompanionFiles = originalSyncCompanionFiles;
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
        const originalSyncCompanionFiles = sessionPrepareDeps.syncCompanionFiles;
        const originalProjectWorkingRepo = sessionPrepareDeps.projectLaunch;
        sessionPrepareDeps.syncCompanionFiles = syncCompanionFiles;
        sessionPrepareDeps.projectLaunch = projectWorkingRepo;

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
          sessionPrepareDeps.syncCompanionFiles = originalSyncCompanionFiles;
          sessionPrepareDeps.projectLaunch = originalProjectWorkingRepo;
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
    sessionPrepareDeps.refreshProjectionRoot = originalRefreshProjectionRoot;
    const syncCompanionFiles = mock(async () => {});
    const projectWorkingRepo = mock(async () => projectedNothing());
    const originalSyncCompanionFiles = sessionPrepareDeps.syncCompanionFiles;
    const originalProjectWorkingRepo = sessionPrepareDeps.projectLaunch;
    sessionPrepareDeps.syncCompanionFiles = syncCompanionFiles;
    sessionPrepareDeps.projectLaunch = projectWorkingRepo;
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
      sessionPrepareDeps.syncCompanionFiles = originalSyncCompanionFiles;
      sessionPrepareDeps.projectLaunch = originalProjectWorkingRepo;
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
    const originalSyncCompanionFiles = sessionPrepareDeps.syncCompanionFiles;
    sessionPrepareDeps.syncCompanionFiles = syncCompanionFiles;

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
      sessionPrepareDeps.syncCompanionFiles = originalSyncCompanionFiles;
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
    const originalSyncCompanionFiles = sessionPrepareDeps.syncCompanionFiles;
    const originalProjectWorkingRepo = sessionPrepareDeps.projectLaunch;
    sessionPrepareDeps.syncCompanionFiles = syncCompanionFiles;
    sessionPrepareDeps.projectLaunch = projectWorkingRepo;
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
      sessionPrepareDeps.syncCompanionFiles = originalSyncCompanionFiles;
      sessionPrepareDeps.projectLaunch = originalProjectWorkingRepo;
    }
  });
});

/**
 * Wrapping and a Managed Session are exclusive (ADR-015). A wrapped repository
 * already delivers the companion through documents the runtime discovers itself,
 * and the launch flags that deliver it a second time are irreducible (ADR-014),
 * so a launch on top would double every contribution rather than replace one.
 */
describe("launching in a wrapped working repository", () => {
  test("is refused before anything is written", async () => {
    const { launcher, adapter } = createLauncher();
    const syncCompanionGit = mock(async () => {});
    const syncCompanionFiles = mock(async () => {});
    const projectWorkingRepo = mock(async () => projectedNothing());

    const originalSyncCompanionGit = sessionPrepareDeps.syncCompanionGit;
    const originalSyncCompanionFiles = sessionPrepareDeps.syncCompanionFiles;
    const originalProjectWorkingRepo = sessionPrepareDeps.projectLaunch;
    sessionPrepareDeps.syncCompanionGit = syncCompanionGit;
    sessionPrepareDeps.syncCompanionFiles = syncCompanionFiles;
    sessionPrepareDeps.projectLaunch = projectWorkingRepo;
    isWrapped.mockResolvedValue(true);

    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
    });

    try {
      await expect(launcher.prepare(makeRequest())).rejects.toThrow(LaunchPreflightError);
      await expect(launcher.prepare(makeRequest())).rejects.toThrow(
        /repo is wrapped[\s\S]*mate unwrap/,
      );
    } finally {
      sessionPrepareDeps.syncCompanionGit = originalSyncCompanionGit;
      sessionPrepareDeps.syncCompanionFiles = originalSyncCompanionFiles;
      sessionPrepareDeps.projectLaunch = originalProjectWorkingRepo;
    }

    /**
     * Every write the launch itself performs is skipped. The Projection-Root
     * refresh inside companion resolution is not one of them — it has already
     * run by the time `prepare` is entered, and `resolveConfig` is stubbed here —
     * so `refreshProjectionRoot` below is the launcher's own site 4 call.
     */
    expect(syncCompanionGit).not.toHaveBeenCalled();
    expect(syncCompanionFiles).not.toHaveBeenCalled();
    expect(projectWorkingRepo).not.toHaveBeenCalled();
    expect(refreshProjectionRoot).not.toHaveBeenCalled();
    expect(adapter.validateLaunch).not.toHaveBeenCalled();
    expect(adapter.run).not.toHaveBeenCalled();
  });

  test("an unwrapped repository still launches", async () => {
    const { launcher, adapter } = createLauncher();
    const originalSyncCompanionFiles = sessionPrepareDeps.syncCompanionFiles;
    const originalProjectWorkingRepo = sessionPrepareDeps.projectLaunch;
    sessionPrepareDeps.syncCompanionFiles = mock(async () => {});
    sessionPrepareDeps.projectLaunch = mock(async () => projectedNothing());

    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
    });

    try {
      await (await launcher.prepare(makeRequest())).execute();
    } finally {
      sessionPrepareDeps.syncCompanionFiles = originalSyncCompanionFiles;
      sessionPrepareDeps.projectLaunch = originalProjectWorkingRepo;
    }

    expect(isWrapped).toHaveBeenCalledWith("/tmp/repo", "claude");
    expect(adapter.run).toHaveBeenCalled();
  });
});

describe("a managed OpenCode launch", () => {
  const original = { prepareSession: launcherDeps.prepareSession };
  const order: string[] = [];

  function openCodeLauncher(options: { current?: boolean; ok?: boolean } = {}) {
    const adapter = new TestAdapter();
    const { launcher } = createLauncher(adapter);
    (launcher as unknown as { adapters: Map<string, LaunchAdapter> }).adapters = new Map([
      ["opencode", adapter],
    ]);
    (launcher as unknown as { resolveConfig(): Promise<LaunchContext> }).resolveConfig = async () =>
      ({
        companionPath: "/tmp/companion",
        launchWorkingDirectory: "/tmp/repo",
        repositoryId: "repo",
        configStore: {
          load: async () => ({ allowedAgents: ["opencode"], capabilities: [], git: "auto" }),
        },
        workingRepoStore: {},
      }) as LaunchContext;
    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
    });
    launcherDeps.prepareSession = mock(
      async (input: { mode: "attended"; runtime: "opencode"; skipGit?: boolean }) => {
        order.push(`prepare:${input.runtime}:${input.mode}${input.skipGit ? ":no-git" : ""}`);
        return {
          ok: options.ok ?? true,
          mode: input.mode,
          runtime: input.runtime,
          repositoryId: "repo",
          companionPath: "/tmp/companion",
          steps: [
            {
              step: "working-target" as const,
              outcome: "ok" as const,
              detail: options.current ? "current" : "updated (wrote .opencode/opencode.json)",
            },
            {
              step: "preflight" as const,
              outcome: options.ok === false ? ("failed" as const) : ("ok" as const),
              detail: "acme",
            },
          ],
          warnings: [],
        };
      },
    );
    return { launcher, adapter };
  }

  beforeEach(() => {
    order.length = 0;
  });

  afterEach(() => {
    Object.assign(launcherDeps, original);
  });

  test("prepares in one pass, reporting a wrap it wrote, then runs", async () => {
    const { launcher, adapter } = openCodeLauncher();
    const errors = spyOn(process.stderr, "write").mockImplementation(() => true);

    await (await launcher.prepare(makeRequest({ tool: "opencode", args: [] }))).execute();

    const lines = errors.mock.calls.map((call) => String(call[0]).trimEnd());
    errors.mockRestore();
    expect(order).toEqual(["prepare:opencode:attended"]);
    expect(lines).toContain(
      "mate: wrapped repo for OpenCode: updated (wrote .opencode/opencode.json)",
    );
    expect(adapter.run).toHaveBeenCalled();
  });

  test("a current wrap is not reported", async () => {
    const { launcher } = openCodeLauncher({ current: true });
    const errors = spyOn(process.stderr, "write").mockImplementation(() => true);

    await launcher.prepare(makeRequest({ tool: "opencode", args: [] }));

    const lines = errors.mock.calls.map((call) => String(call[0]).trimEnd());
    errors.mockRestore();
    expect(order).toEqual(["prepare:opencode:attended"]);
    expect(lines.some((line) => line.includes("wrapped"))).toBe(false);
  });

  test("is never refused in a wrapped repository", async () => {
    const { launcher, adapter } = openCodeLauncher({ current: true });
    isWrapped.mockResolvedValue(true);

    await (await launcher.prepare(makeRequest({ tool: "opencode", args: [] }))).execute();

    expect(adapter.run).toHaveBeenCalled();
  });

  test("--no-git skips only the Git sync of the attended prepare", async () => {
    const { launcher } = openCodeLauncher({ current: true });

    await launcher.prepare(makeRequest({ tool: "opencode", args: [], skipGit: true }));

    expect(order).toEqual(["prepare:opencode:attended:no-git"]);
  });

  test("a failed prepare step fails the launch before OpenCode runs", async () => {
    const { launcher, adapter } = openCodeLauncher({ current: true, ok: false });

    await expect(launcher.prepare(makeRequest({ tool: "opencode", args: [] }))).rejects.toThrow(
      /preflight: acme/,
    );
    expect(adapter.run).not.toHaveBeenCalled();
  });
});

describe("the wrapped-repository refusal is scoped to Claude", () => {
  test("an OpenCode-only wrap does not refuse mate claude", async () => {
    const { launcher, adapter } = createLauncher();
    const originalFiles = sessionPrepareDeps.syncCompanionFiles;
    const originalProject = sessionPrepareDeps.projectLaunch;
    sessionPrepareDeps.syncCompanionFiles = mock(async () => {});
    sessionPrepareDeps.projectLaunch = mock(async () => projectedNothing());
    isWrapped.mockImplementation(
      (async (_repo: string, runtime: string) => runtime === "opencode") as never,
    );
    spyOn(CompanionStore.prototype, "getRepository").mockResolvedValue({
      id: "repo",
      path: "/tmp/repo",
    });

    try {
      await (await launcher.prepare(makeRequest())).execute();
    } finally {
      sessionPrepareDeps.syncCompanionFiles = originalFiles;
      sessionPrepareDeps.projectLaunch = originalProject;
    }

    expect(adapter.run).toHaveBeenCalled();
  });
});
