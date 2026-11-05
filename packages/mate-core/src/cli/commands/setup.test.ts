import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ReactElement } from "react";

import { FRAMEWORK_NAME } from "../../framework";
import {
  createStartupProgress,
  type StartupProgressAppProps,
  type StartupProgressDeps,
} from "../../lib/components/startup-progress";
import { emitWarning } from "../../lib/live-progress";
import { ConfigStore } from "../../lib/orchestrator/config-store";
import type { SetupDependencies } from "../../tools/setup";
import { runSetupCommand, runSetupCommandWithDeps, setupCommandDeps } from "./setup";
import type { SetupSelections } from "../../lib/orchestrator/setup-compatibilities";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

async function withProcessExitStub<T>(fn: () => Promise<T>): Promise<{ error: unknown }> {
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`EXIT:${code ?? 0}`);
  }) as typeof process.exit;

  try {
    await fn();
    return { error: null };
  } catch (error) {
    return { error };
  } finally {
    process.exit = originalExit;
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("runSetupCommand", () => {
  test("delegates to runSetupCommandWithDeps via the exported wrapper deps", async () => {
    const original = setupCommandDeps.runSetupCommandWithDeps;
    const wrapperMock = mock(async () => {});
    setupCommandDeps.runSetupCommandWithDeps = wrapperMock;

    try {
      await runSetupCommand(["--capability", "graphify"]);
    } finally {
      setupCommandDeps.runSetupCommandWithDeps = original;
    }

    expect(wrapperMock).toHaveBeenCalledWith(["--capability", "graphify"]);
  });
});

describe("runSetupCommandWithDeps", () => {
  test("prompts for unrecognized directories and aborts when declined", async () => {
    const cwd = await makeTempDir("mate-setup-cli-decline-");
    const confirmMock = mock(async () => false);
    const executeMock = mock(async () => {
      throw new Error("setup should not run");
    });

    const { error } = await withProcessExitStub(() =>
      withCwd(cwd, () =>
        runSetupCommandWithDeps([], {
          confirm: confirmMock,
          inspectSetupPreflight: async () => ({ kind: "unrecognized" }),
          executeSetup: executeMock as never,
        }),
      ),
    );

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(executeMock).not.toHaveBeenCalled();
    expect(String(error)).toContain("EXIT:1");
    await expect(fs.access(path.join(cwd, `.${FRAMEWORK_NAME}`))).rejects.toThrow();
  });

  test("skips confirmation for existing companions", async () => {
    const cwd = await makeTempDir("mate-setup-cli-existing-");
    const confirmMock = mock(async () => false);
    const selectorMock = mock(
      async () =>
        ({
          allowedAgents: ["claude"],
          packageManagers: ["bun"],
          capabilities: [],
          selectedGitMode: "default",
        }) satisfies SetupSelections,
    );
    const executeMock = mock(async () => ({
      config: {
        allowedAgents: ["claude"],
        packageManagers: ["bun"],
        capabilities: [],
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps([], {
        confirm: confirmMock,
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        selectSetupCompatibilities: selectorMock,
        executeSetup: executeMock as never,
      }),
    );

    expect(confirmMock).not.toHaveBeenCalled();
    expect(selectorMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  test("prompts for unrecognized directories and continues when confirmed", async () => {
    const cwd = await makeTempDir("mate-setup-cli-confirm-");
    const confirmMock = mock(async () => true);
    const selectorMock = mock(
      async () =>
        ({
          allowedAgents: ["claude"],
          packageManagers: ["bun"],
          capabilities: [],
          selectedGitMode: "default",
        }) satisfies SetupSelections,
    );
    const executeMock = mock(async () => ({
      config: {
        allowedAgents: ["claude"],
        packageManagers: ["bun"],
        capabilities: [],
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps([], {
        confirm: confirmMock,
        inspectSetupPreflight: async () => ({ kind: "unrecognized" }),
        selectSetupCompatibilities: selectorMock,
        executeSetup: executeMock as never,
      }),
    );

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(selectorMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  test("prints a warning when the directory looks like a working repo", async () => {
    const cwd = await makeTempDir("mate-setup-cli-working-repo-warn-");
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    const selectorMock = mock(
      async () =>
        ({
          allowedAgents: ["claude"],
          packageManagers: ["bun"],
          capabilities: [],
          selectedGitMode: "default",
        }) satisfies SetupSelections,
    );
    const executeMock = mock(async () => ({
      config: {
        allowedAgents: ["claude"],
        packageManagers: ["bun"],
        capabilities: [],
      },
    }));

    try {
      await withCwd(cwd, () =>
        runSetupCommandWithDeps([], {
          confirm: async () => true,
          inspectSetupPreflight: async () => ({ kind: "unrecognized" }),
          looksLikeWorkingRepo: async () => true,
          selectSetupCompatibilities: selectorMock,
          executeSetup: executeMock as never,
        }),
      );
    } finally {
      process.stderr.write = originalWrite;
    }

    const stderr = stderrChunks.join("");
    expect(stderr).toContain("Warning");
    expect(stderr).toContain("working repository");
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  test("passes an explicit capability through to setup tool", async () => {
    const cwd = await makeTempDir("mate-setup-cli-graphify-");
    const selectorMock = mock(async () => {
      throw new Error("selector should not run");
    });
    const executeMock = mock(async () => ({
      config: {
        allowedAgents: ["claude"],
        capabilities: [{ name: "graphify" }],
        packageManagers: ["bun"],
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps(["--capability", "graphify"], {
        confirm: async () => true,
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        selectSetupCompatibilities: selectorMock,
        executeSetup: executeMock as never,
      }),
    );

    expect(selectorMock).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledWith(
      {
        allowedAgents: ["claude"],
        packageManagers: ["bun"],
        capabilities: [{ name: "graphify" }],
        git: "default",
      },
      expect.objectContaining({ cwd: expect.stringContaining(path.basename(cwd)) }),
    );
  });

  test("passes explicit package manager flags through to setup tool", async () => {
    const cwd = await makeTempDir("mate-setup-cli-package-managers-");
    const selectorMock = mock(async () => {
      throw new Error("selector should not run");
    });
    const executeMock = mock(async () => ({
      config: {
        allowedAgents: ["claude"],
        packageManagers: ["bun", "uv"],
        capabilities: [],
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps(["--package-manager", "bun", "--package-manager", "uv"], {
        confirm: async () => true,
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        selectSetupCompatibilities: selectorMock,
        executeSetup: executeMock as never,
      }),
    );

    expect(selectorMock).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledWith(
      {
        allowedAgents: ["claude"],
        packageManagers: ["bun", "uv"],
        capabilities: [{ name: "openspec" }, { name: "react-doctor" }],
        git: "default",
      },
      expect.objectContaining({ cwd: expect.stringContaining(path.basename(cwd)) }),
    );
  });

  test("ignores a leftover --openspec-schema flag", async () => {
    const cwd = await makeTempDir("mate-setup-cli-openspec-schema-");
    const selectorMock = mock(async () => {
      throw new Error("selector should not run");
    });
    const executeMock = mock(async () => ({
      config: {
        allowedAgents: ["claude"],
        packageManagers: ["bun", "uv"],
        capabilities: [{ name: "openspec" }],
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps(["--capability", "openspec", "--openspec-schema", "mate-v1"], {
        confirm: async () => true,
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        selectSetupCompatibilities: selectorMock,
        executeSetup: executeMock as never,
      }),
    );

    expect(selectorMock).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledWith(
      {
        allowedAgents: ["claude"],
        packageManagers: ["bun"],
        capabilities: [{ name: "openspec" }],
        git: "default",
      },
      expect.objectContaining({ cwd: expect.stringContaining(path.basename(cwd)) }),
    );
  });

  test("passes explicit git mode flag through to setup tool", async () => {
    const cwd = await makeTempDir("mate-setup-cli-git-mode-");
    const selectorMock = mock(async () => {
      throw new Error("selector should not run");
    });
    const executeMock = mock(async () => ({
      config: {
        allowedAgents: ["claude"],
        packageManagers: ["bun", "uv"],
        capabilities: [{ name: "openspec" }],
        git: "auto",
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps(["--capability", "openspec", "--git-mode", "auto"], {
        confirm: async () => true,
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        selectSetupCompatibilities: selectorMock,
        executeSetup: executeMock as never,
      }),
    );

    expect(selectorMock).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledWith(
      {
        allowedAgents: ["claude"],
        packageManagers: ["bun"],
        capabilities: [{ name: "openspec" }],
        git: "auto",
      },
      expect.objectContaining({ cwd: expect.stringContaining(path.basename(cwd)) }),
    );
  });

  describe("--ticket", () => {
    async function companionWith(openspec: Record<string, unknown> | null): Promise<string> {
      const companionPath = await makeTempDir("mate-setup-cli-ticket-");
      await new ConfigStore(
        path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
      ).save({
        type: "companion",
        allowedAgents: ["claude"],
        packageManagers: ["bun"],
        capabilities: openspec ? [{ name: "openspec", ...openspec }] : [],
      });
      return companionPath;
    }

    function execute() {
      return mock(async () => ({ config: { allowedAgents: [], capabilities: [] } }));
    }

    async function setup(companionPath: string, argv: string[], executeMock = execute()) {
      const selectorMock = mock(async () => {
        throw new Error("selector should not run");
      });
      const outcome = await withProcessExitStub(() =>
        withCwd(companionPath, () =>
          runSetupCommandWithDeps(argv, {
            inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
            selectSetupCompatibilities: selectorMock,
            executeSetup: executeMock as never,
          }),
        ),
      );
      expect(selectorMock).not.toHaveBeenCalled();
      return { ...outcome, executeMock };
    }

    test("jira saves the setting and keeps the other openspec settings", async () => {
      const companionPath = await companionWith({ protectedBranches: ["release/*"] });
      const { executeMock } = await setup(companionPath, ["--ticket", "jira"]);
      expect(executeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          capabilities: [{ name: "openspec", protectedBranches: ["release/*"], ticket: "jira" }],
        }),
        expect.anything(),
      );
    });

    test("none removes the saved setting", async () => {
      const companionPath = await companionWith({ ticket: "jira" });
      const { executeMock } = await setup(companionPath, ["--ticket", "none"]);
      expect(executeMock).toHaveBeenCalledWith(
        expect.objectContaining({ capabilities: [{ name: "openspec" }] }),
        expect.anything(),
      );
    });

    test("other flags keep a saved jira setting", async () => {
      const companionPath = await companionWith({ ticket: "jira" });
      const { executeMock } = await setup(companionPath, ["--git-mode", "auto"]);
      expect(executeMock).toHaveBeenCalledWith(
        expect.objectContaining({ capabilities: [{ name: "openspec", ticket: "jira" }] }),
        expect.anything(),
      );
    });

    test("without openspec setup refuses and saves nothing", async () => {
      const companionPath = await companionWith(null);
      const executeMock = mock(async () => {
        throw new Error("setup should not run");
      });
      const { error } = await setup(companionPath, ["--ticket", "jira"], executeMock as never);
      expect(String(error)).toContain("EXIT:1");
      expect(executeMock).not.toHaveBeenCalled();
    });

    test("an unknown value is refused", async () => {
      const companionPath = await companionWith({});
      const executeMock = mock(async () => {
        throw new Error("setup should not run");
      });
      const { error } = await setup(companionPath, ["--ticket", "linear"], executeMock as never);
      expect(String(error)).toContain("EXIT:1");
    });
  });

  test("aborts when the compatibility selector is cancelled", async () => {
    const cwd = await makeTempDir("mate-setup-cli-cancel-");
    const executeMock = mock(async () => {
      throw new Error("setup should not run");
    });

    const { error } = await withProcessExitStub(() =>
      withCwd(cwd, () =>
        runSetupCommandWithDeps([], {
          confirm: async () => true,
          inspectSetupPreflight: async () => ({ kind: "unrecognized" }),
          selectSetupCompatibilities: async () => null,
          executeSetup: executeMock as never,
        }),
      ),
    );

    expect(executeMock).not.toHaveBeenCalled();
    expect(String(error)).toContain("EXIT:1");
  });

  test("passes explicit selections straight through for linked working repositories", async () => {
    const cwd = await makeTempDir("mate-setup-cli-linked-working-repo-");
    const companionPath = await makeTempDir("mate-setup-cli-linked-working-repo-companion-");
    const selectorMock = mock(async () => {
      throw new Error("selector should not run");
    });
    const executeMock = mock(async () => ({
      config: {
        allowedAgents: ["opencode"],
        packageManagers: ["bun", "uv"],
        capabilities: [{ name: "graphify" }],
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps(
        ["--allowed-agent", "opencode", "--package-manager", "uv", "--capability", "graphify"],
        {
          inspectSetupPreflight: async () => ({
            kind: "linked-working-repo",
            match: { companionPath, repositoryId: "repo" },
          }),
          selectSetupCompatibilities: selectorMock,
          executeSetup: executeMock as never,
        },
      ),
    );

    expect(selectorMock).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedAgents: ["opencode"],
        packageManagers: ["uv"],
        capabilities: [{ name: "graphify" }],
      }),
      expect.objectContaining({ cwd: companionPath }),
    );
  });

  test("runs the interactive picker seeded from the companion config for no-flag linked setup", async () => {
    const cwd = await makeTempDir("mate-setup-cli-linked-no-flags-");
    const companionPath = await makeTempDir("mate-setup-cli-linked-no-flags-companion-");
    await new ConfigStore(
      path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
    ).save({
      type: "companion",
      allowedAgents: ["opencode"],
      packageManagers: ["bun"],
      capabilities: [{ name: "graphify" }],
    });
    const selectorMock = mock(
      async () =>
        ({
          allowedAgents: ["opencode"],
          packageManagers: ["bun"],
          capabilities: [{ name: "graphify" }],
          selectedGitMode: "default",
        }) satisfies SetupSelections,
    );
    const executeMock = mock(async () => ({
      config: {
        allowedAgents: ["opencode"],
        packageManagers: ["bun"],
        capabilities: [{ name: "graphify" }],
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps([], {
        inspectSetupPreflight: async () => ({
          kind: "linked-working-repo",
          match: { companionPath, repositoryId: "repo" },
        }),
        selectSetupCompatibilities: selectorMock,
        executeSetup: executeMock as never,
      }),
    );

    expect(selectorMock).toHaveBeenCalledWith({
      initialSelections: expect.objectContaining({
        allowedAgents: ["opencode"],
        capabilities: [{ name: "graphify" }],
      }),
    });
    expect(executeMock).toHaveBeenCalledWith(
      {
        allowedAgents: ["opencode"],
        packageManagers: ["bun"],
        capabilities: [{ name: "graphify" }],
        git: "default",
      },
      expect.objectContaining({ cwd: companionPath }),
    );
  });

  test("preserves capabilities for non-capability linked setup flags", async () => {
    const cwd = await makeTempDir("mate-setup-cli-linked-non-capability-flags-");
    const companionPath = await makeTempDir("mate-setup-cli-linked-non-capability-companion-");
    await new ConfigStore(
      path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
    ).save({
      type: "companion",
      allowedAgents: ["claude"],
      packageManagers: ["bun"],
      capabilities: [{ name: "openspec" }],
    });
    const executeMock = mock(async () => ({
      config: {
        allowedAgents: ["opencode"],
        packageManagers: ["uv"],
        capabilities: [{ name: "openspec" }],
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps(
        ["--allowed-agent", "opencode", "--package-manager", "uv", "--git-mode", "auto"],
        {
          inspectSetupPreflight: async () => ({
            kind: "linked-working-repo",
            match: { companionPath, repositoryId: "repo" },
          }),
          executeSetup: executeMock as never,
        },
      ),
    );

    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedAgents: ["opencode"],
        packageManagers: ["uv"],
        capabilities: [{ name: "openspec" }],
        git: "auto",
      }),
      expect.objectContaining({ cwd: companionPath }),
    );
  });

  test("selects a companion before setup when a working repo has multiple links", async () => {
    const cwd = await makeTempDir("mate-setup-cli-ambiguous-working-repo-");
    const companionA = await makeTempDir("mate-setup-cli-ambiguous-companion-a-");
    const companionB = await makeTempDir("mate-setup-cli-ambiguous-companion-b-");
    const selectCompanionMock = mock(async () => ({
      companionPath: companionB,
      repositoryId: "repo-b",
    }));
    const selectorMock = mock(
      async () =>
        ({
          allowedAgents: ["claude"],
          packageManagers: ["bun"],
          capabilities: [],
          selectedGitMode: "default",
        }) satisfies SetupSelections,
    );
    const executeMock = mock(async () => ({
      config: {
        allowedAgents: ["claude"],
        packageManagers: ["bun"],
        capabilities: [],
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps([], {
        inspectSetupPreflight: async () => ({
          kind: "linked-working-repo",
          match: { companionPath: companionA, repositoryId: "repo-a" },
          ambiguousMatches: [
            { companionPath: companionA, repositoryId: "repo-a" },
            { companionPath: companionB, repositoryId: "repo-b" },
          ],
        }),
        selectCompanion: selectCompanionMock,
        selectSetupCompatibilities: selectorMock,
        executeSetup: executeMock as never,
      }),
    );

    expect(selectCompanionMock).toHaveBeenCalledWith([
      { companionPath: companionA, repositoryId: "repo-a" },
      { companionPath: companionB, repositoryId: "repo-b" },
    ]);
    expect(selectorMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedAgents: ["claude"],
        packageManagers: ["bun"],
        capabilities: [],
      }),
      expect.objectContaining({ cwd: companionB }),
    );
  });

  test("honors a pinned MATE_ARTIFACT_PATH instead of prompting again on multiple links", async () => {
    const cwd = await makeTempDir("mate-setup-cli-pinned-working-repo-");
    const companionA = await makeTempDir("mate-setup-cli-pinned-companion-a-");
    const companionB = await makeTempDir("mate-setup-cli-pinned-companion-b-");
    const selectCompanionMock = mock(async () => {
      throw new Error("companion selector should not run");
    });
    const executeMock = mock(async () => ({
      config: {
        allowedAgents: ["claude"],
        packageManagers: ["bun"],
        capabilities: [],
      },
    }));

    const previousPin = process.env.MATE_ARTIFACT_PATH;
    process.env.MATE_ARTIFACT_PATH = companionB;
    try {
      await withCwd(cwd, () =>
        runSetupCommandWithDeps(["--allowed-agent", "claude"], {
          inspectSetupPreflight: async () => ({
            kind: "linked-working-repo",
            match: { companionPath: companionA, repositoryId: "repo-a" },
            ambiguousMatches: [
              { companionPath: companionA, repositoryId: "repo-a" },
              { companionPath: companionB, repositoryId: "repo-b" },
            ],
          }),
          selectCompanion: selectCompanionMock,
          executeSetup: executeMock as never,
        }),
      );
    } finally {
      if (previousPin === undefined) {
        delete process.env.MATE_ARTIFACT_PATH;
      } else {
        process.env.MATE_ARTIFACT_PATH = previousPin;
      }
    }

    expect(selectCompanionMock).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({ allowedAgents: ["claude"] }),
      expect.objectContaining({ cwd: companionB }),
    );
  });
});

describe("setup progress", () => {
  const summaryConfig = {
    config: { allowedAgents: ["claude"], packageManagers: ["bun"], capabilities: [] },
  };

  /** Plain progress and the summary's console.log share one transcript, in order. */
  function captureTranscript() {
    const chunks: string[] = [];
    const stream = {
      isTTY: false,
      columns: 80,
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      chunks.push(`${args.join(" ")}\n`);
    });
    return {
      createProgress: (title: string) => createStartupProgress(title, { stdout: stream }),
      transcript: () => chunks.join(""),
      restore: () => log.mockRestore(),
    };
  }

  function runPhases(failAt?: string) {
    return mock(async (_input: unknown, setupDeps?: SetupDependencies) => {
      for (const [id, label] of [
        ["plugins", "Installing plugins"],
        ["capabilities", "Applying capabilities"],
        ["register", "Registering companion"],
      ]) {
        await setupDeps?.progress?.step(id, label, () => {
          if (id === failAt) throw new Error("acme broke");
        });
      }
      return summaryConfig;
    });
  }

  test("prints one line per phase before the summary", async () => {
    const cwd = await makeTempDir("mate-setup-cli-progress-");
    const capture = captureTranscript();
    try {
      await withCwd(cwd, () =>
        runSetupCommandWithDeps(["--allowed-agent", "claude"], {
          inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
          executeSetup: runPhases() as never,
          createProgress: capture.createProgress,
        }),
      );
    } finally {
      capture.restore();
    }

    const lines = capture.transcript().split("\n");
    expect(lines.slice(0, 4)).toEqual([
      "mate · Setting up companion",
      "  ✓ Installing plugins",
      "  ✓ Applying capabilities",
      "  ✓ Registering companion",
    ]);
    expect(lines.findIndex((line) => line.includes("allowedAgents"))).toBeGreaterThan(3);
  });

  test("a failing phase ends with ✗ before the error propagates", async () => {
    const cwd = await makeTempDir("mate-setup-cli-progress-fail-");
    const capture = captureTranscript();
    try {
      await expect(
        withCwd(cwd, () =>
          runSetupCommandWithDeps(["--allowed-agent", "claude"], {
            inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
            executeSetup: runPhases("capabilities") as never,
            createProgress: capture.createProgress,
          }),
        ),
      ).rejects.toThrow("acme broke");
    } finally {
      capture.restore();
    }

    expect(capture.transcript()).toContain("  ✗ Applying capabilities failed\n");
    expect(capture.transcript()).not.toContain("Registering companion");
    expect(capture.transcript()).not.toContain("allowedAgents");
  });

  test("a skip-reason warning joins the log above the live line", async () => {
    const cwd = await makeTempDir("mate-setup-cli-progress-warn-");
    const renders: StartupProgressAppProps[] = [];
    const render = ((element: ReactElement) => {
      renders.push(element.props as StartupProgressAppProps);
      return {
        rerender: (next: ReactElement) => renders.push(next.props as StartupProgressAppProps),
        unmount: () => {},
      };
    }) as unknown as NonNullable<StartupProgressDeps["render"]>;
    const executeMock = mock(async (_input: unknown, setupDeps?: SetupDependencies) => {
      await setupDeps?.progress?.step("capabilities", "Applying capabilities", () => {
        emitWarning("tokensave capability disabled: requires uv package manager");
      });
      return summaryConfig;
    });

    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await withCwd(cwd, () =>
        runSetupCommandWithDeps(["--allowed-agent", "claude"], {
          inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
          executeSetup: executeMock as never,
          createProgress: (title) => createStartupProgress(title, { render, interactive: true }),
        }),
      );
    } finally {
      log.mockRestore();
    }

    const warned = renders.find((props) => props.log.some((entry) => entry.kind === "warning"));
    expect(warned?.log).toEqual([
      {
        key: "warning:0",
        kind: "warning",
        label: "tokensave capability disabled: requires uv package manager",
      },
    ]);
    expect(warned?.steps).toEqual([
      { id: "capabilities", label: "Applying capabilities", status: "running" },
    ]);
  });
});
