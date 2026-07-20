import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { frameworkConfig } from "../../framework";
import { ConfigStore } from "../../lib/orchestrator/config-store";
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
      await runSetupCommand(["--capability", "headroom"]);
    } finally {
      setupCommandDeps.runSetupCommandWithDeps = original;
    }

    expect(wrapperMock).toHaveBeenCalledWith(["--capability", "headroom"]);
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
    await expect(fs.access(path.join(cwd, `.${frameworkConfig.name}`))).rejects.toThrow();
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
          selectedOpenSpecSchema: "default",
          selectedGitMode: "default",
        }) satisfies SetupSelections,
    );
    const executeMock = mock(async () => ({
      config: {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
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
          selectedOpenSpecSchema: "default",
          selectedGitMode: "default",
        }) satisfies SetupSelections,
    );
    const executeMock = mock(async () => ({
      config: {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
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
          selectedOpenSpecSchema: "default",
          selectedGitMode: "default",
        }) satisfies SetupSelections,
    );
    const executeMock = mock(async () => ({
      config: {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
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

  test("passes headroom capability through to setup tool", async () => {
    const cwd = await makeTempDir("mate-setup-cli-headroom-");
    const selectorMock = mock(async () => {
      throw new Error("selector should not run");
    });
    const executeMock = mock(async () => ({
      config: {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        capabilities: [{ name: "headroom" }],
        packageManagers: ["bun"],
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps(["--capability", "headroom"], {
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
        capabilities: [{ name: "headroom" }],
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
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
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

  test("passes explicit openspec schema flag through to setup tool", async () => {
    const cwd = await makeTempDir("mate-setup-cli-openspec-schema-");
    const selectorMock = mock(async () => {
      throw new Error("selector should not run");
    });
    const executeMock = mock(async () => ({
      config: {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        packageManagers: ["bun", "uv"],
        capabilities: [{ name: "openspec", schemaProfile: "mate-v1" }],
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
        packageManagers: ["bun", "uv"],
        capabilities: [{ name: "openspec", schemaProfile: "mate-v1" }],
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
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
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
        packageManagers: ["bun", "uv"],
        capabilities: [{ name: "openspec" }],
        git: "auto",
      },
      expect.objectContaining({ cwd: expect.stringContaining(path.basename(cwd)) }),
    );
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
    const selectorMock = mock(async () => {
      throw new Error("selector should not run");
    });
    const executeMock = mock(async () => ({
      config: {
        profiles: { default: { name: "default", allowedAgents: ["opencode"] } },
        packageManagers: ["bun", "uv"],
        capabilities: [{ name: "headroom" }],
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps(
        ["--allowed-agent", "opencode", "--package-manager", "uv", "--capability", "headroom"],
        {
          inspectSetupPreflight: async () => ({
            kind: "linked-working-repo",
            match: { companionPath: "/tmp/companion", repositoryId: "repo" },
          }),
          selectSetupCompatibilities: selectorMock,
          executeSetup: executeMock as never,
        },
      ),
    );

    expect(selectorMock).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledWith(
      {
        allowedAgents: ["opencode"],
        packageManagers: ["uv"],
        capabilities: [{ name: "headroom" }],
      },
      expect.objectContaining({ cwd: "/tmp/companion" }),
    );
  });

  test("omits capabilities for no-flag linked setup", async () => {
    const cwd = await makeTempDir("mate-setup-cli-linked-no-flags-");
    const executeMock = mock(async () => ({
      config: {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        packageManagers: ["bun"],
        capabilities: [{ name: "openspec" }],
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps([], {
        inspectSetupPreflight: async () => ({
          kind: "linked-working-repo",
          match: { companionPath: "/tmp/companion", repositoryId: "repo" },
        }),
        executeSetup: executeMock as never,
      }),
    );

    expect(executeMock).toHaveBeenCalledWith(
      {
        allowedAgents: undefined,
        packageManagers: undefined,
        capabilities: undefined,
        git: undefined,
      },
      { cwd: "/tmp/companion" },
    );
  });

  test("preserves capabilities for non-capability linked setup flags", async () => {
    const cwd = await makeTempDir("mate-setup-cli-linked-non-capability-flags-");
    const executeMock = mock(async () => ({
      config: {
        profiles: { default: { name: "default", allowedAgents: ["opencode"] } },
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
            match: { companionPath: "/tmp/companion", repositoryId: "repo" },
          }),
          executeSetup: executeMock as never,
        },
      ),
    );

    expect(executeMock).toHaveBeenCalledWith(
      {
        allowedAgents: ["opencode"],
        packageManagers: ["uv"],
        capabilities: undefined,
        git: "auto",
      },
      { cwd: "/tmp/companion" },
    );
  });

  test("applies schema-only linked setup to the saved capability selection", async () => {
    const cwd = await makeTempDir("mate-setup-cli-linked-schema-only-");
    const companionPath = await makeTempDir("mate-setup-cli-linked-schema-companion-");
    await new ConfigStore(
      path.join(companionPath, `.${frameworkConfig.name}`, "config", "framework.yaml"),
    ).save({
      type: "companion",
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      packageManagers: ["bun"],
      capabilities: [{ name: "openspec" }, { name: "react-doctor" }],
    });
    const executeMock = mock(async () => ({
      config: {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        packageManagers: ["bun"],
        capabilities: [{ name: "openspec", schemaProfile: "mate-v1" }, { name: "react-doctor" }],
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps(["--openspec-schema", "mate-v1"], {
        inspectSetupPreflight: async () => ({
          kind: "linked-working-repo",
          match: { companionPath, repositoryId: "repo" },
        }),
        executeSetup: executeMock as never,
      }),
    );

    expect(executeMock).toHaveBeenCalledWith(
      {
        allowedAgents: undefined,
        packageManagers: undefined,
        capabilities: [{ name: "openspec", schemaProfile: "mate-v1" }, { name: "react-doctor" }],
        git: undefined,
      },
      { cwd: companionPath },
    );
  });

  test("selects a companion before setup when a working repo has multiple links", async () => {
    const cwd = await makeTempDir("mate-setup-cli-ambiguous-working-repo-");
    const selectCompanionMock = mock(async () => ({
      companionPath: "/tmp/companion-b",
      repositoryId: "repo-b",
    }));
    const executeMock = mock(async () => ({
      config: {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        packageManagers: ["bun"],
        capabilities: [],
      },
    }));

    await withCwd(cwd, () =>
      runSetupCommandWithDeps([], {
        inspectSetupPreflight: async () => ({
          kind: "linked-working-repo",
          match: { companionPath: "/tmp/companion-a", repositoryId: "repo-a" },
          ambiguousMatches: [
            { companionPath: "/tmp/companion-a", repositoryId: "repo-a" },
            { companionPath: "/tmp/companion-b", repositoryId: "repo-b" },
          ],
        }),
        selectCompanion: selectCompanionMock,
        executeSetup: executeMock as never,
      }),
    );

    expect(selectCompanionMock).toHaveBeenCalledWith([
      { companionPath: "/tmp/companion-a", repositoryId: "repo-a" },
      { companionPath: "/tmp/companion-b", repositoryId: "repo-b" },
    ]);
    expect(executeMock).toHaveBeenCalledWith(
      {
        allowedAgents: undefined,
        packageManagers: undefined,
        capabilities: undefined,
        git: undefined,
      },
      { cwd: "/tmp/companion-b" },
    );
  });
});
