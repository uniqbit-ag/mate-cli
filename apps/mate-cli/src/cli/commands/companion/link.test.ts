import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  companionLinkCommandDeps,
  runCompanionLinkCommand,
  runCompanionLinkCommandWithDeps,
} from "./link";
import type { CompanionLinkInputs } from "../../companion-link-wizard";
import type { CompanionSource, LinkedRepository } from "../../../lib/orchestrator/types";
import { frameworkConfig } from "../../../framework";

function withProcessExitStub<T>(fn: () => Promise<T>): Promise<{ error: unknown }> {
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`EXIT:${code ?? 0}`);
  }) as typeof process.exit;
  return fn()
    .then(() => ({ error: null }))
    .catch((error) => ({ error }))
    .finally(() => {
      process.exit = originalExit;
    });
}

function mockSpawnSync(opts: { status: number; stderr?: string; stdout?: string }) {
  return mock(() => ({
    status: opts.status,
    stderr: opts.stderr ?? "",
    stdout: opts.stdout ?? "",
  }));
}

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", prefix));
}

describe("runCompanionLinkCommand", () => {
  test("delegates to runCompanionLinkCommandWithDeps via the exported wrapper", async () => {
    const original = companionLinkCommandDeps.runCompanionLinkCommandWithDeps;
    const wrapperMock = mock(async () => {});
    companionLinkCommandDeps.runCompanionLinkCommandWithDeps = wrapperMock;

    try {
      await runCompanionLinkCommand([]);
    } finally {
      companionLinkCommandDeps.runCompanionLinkCommandWithDeps = original;
    }

    expect(wrapperMock).toHaveBeenCalledWith([]);
  });
});

describe("runCompanionLinkCommandWithDeps", () => {
  test("clones git-backed companions, bootstraps setup, registers source provenance, and injects the workspace", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => logs.push(String(msg ?? ""));

    const registerRepository = mock(
      async (
        repository: LinkedRepository,
        options: { companionPath: string; companionSource: CompanionSource },
      ) => repository,
    );
    const runSetup = mock(async () => {});
    const installCompanion = mock(async () => {});
    const spawn = mockSpawnSync({ status: 0 });

    try {
      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async () => ({
          source: "git",
          gitUrl: "https://github.com/user/test-companion.git",
          profile: "default",
        }),
        extractRepoName: () => "test-companion",
        resolveCompanion: async () => null,
        stat: async () => {
          throw new Error("ENOENT");
        },
        mkdir: async () => {},
        spawnSync: spawn,
        rm: async () => {},
        inspectSetupPreflight: async () => ({ kind: "unrecognized" }),
        runSetupFlowAtPath: runSetup,
        installCompanion,
        registerRepository,
        registerCompanion: async () => {},
        detectInvokingEditorCli: () => "cursor",
        injectEditorFolder: async () => true,
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      console.log = originalLog;
    }

    const expectedCompanionPath = path.join(
      path.join(process.env.HOME!, ".mate", "companions"),
      "test-companion",
    );
    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["clone", "git@github.com:user/test-companion.git", expectedCompanionPath],
      expect.any(Object),
    );
    expect(runSetup).toHaveBeenCalledWith(expectedCompanionPath);
    expect(installCompanion).toHaveBeenCalledWith(expectedCompanionPath);
    expect(registerRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        id: path.basename(process.cwd()),
        path: path.resolve(process.cwd()),
        profile: "default",
      }),
      {
        companionPath: expectedCompanionPath,
        companionSource: "git",
      },
    );
    expect(logs.join("\n")).toContain("Workspace: injected into cursor");
  });

  test("tries GitHub SSH before falling back to the pasted HTTPS URL", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => logs.push(String(msg ?? ""));

    const registerRepository = mock(
      async (
        repository: LinkedRepository,
        options: { companionPath: string; companionSource: CompanionSource },
      ) => repository,
    );
    const runSetup = mock(async () => {});
    const spawn = mockSpawnSync({ status: 0 });

    try {
      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async () => ({
          source: "git",
          gitUrl: "https://github.com/user/test-companion.git",
          profile: "default",
        }),
        extractRepoName: () => "test-companion",
        resolveCompanion: async () => null,
        stat: async () => {
          throw new Error("ENOENT");
        },
        mkdir: async () => {},
        spawnSync: spawn,
        rm: async () => {},
        inspectSetupPreflight: async () => ({ kind: "unrecognized" }),
        runSetupFlowAtPath: runSetup,
        installCompanion: async () => {},
        registerRepository,
        registerCompanion: async () => {},
        detectInvokingEditorCli: () => null,
        injectEditorFolder: async () => true,
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      console.log = originalLog;
    }

    const expectedCompanionPath = path.join(
      path.join(process.env.HOME!, ".mate", "companions"),
      "test-companion",
    );
    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["clone", "git@github.com:user/test-companion.git", expectedCompanionPath],
      expect.any(Object),
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("Source: git");
  });

  test("reuses an existing git companion directory instead of failing or recloning", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => logs.push(String(msg ?? ""));

    const registerRepository = mock(
      async (
        repository: LinkedRepository,
        options: { companionPath: string; companionSource: CompanionSource },
      ) => repository,
    );
    const runSetup = mock(async () => {});
    const spawn = mockSpawnSync({ status: 0 });

    try {
      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async () => ({
          source: "git",
          gitUrl: "https://github.com/user/test-companion.git",
          profile: "default",
        }),
        extractRepoName: () => "test-companion",
        resolveCompanion: async () => null,
        stat: async (candidatePath: string) =>
          ({
            isDirectory: () =>
              candidatePath.endsWith(path.join(".mate", "companions", "test-companion")),
          }) as Awaited<ReturnType<typeof fs.stat>>,
        mkdir: async () => {},
        spawnSync: spawn,
        rm: async () => {},
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        runSetupFlowAtPath: runSetup,
        installCompanion: async () => {},
        registerRepository,
        registerCompanion: async () => {},
        detectInvokingEditorCli: () => null,
        injectEditorFolder: async () => true,
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      console.log = originalLog;
    }

    const expectedCompanionPath = path.join(
      path.join(process.env.HOME!, ".mate", "companions"),
      "test-companion",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(runSetup).not.toHaveBeenCalled();
    expect(registerRepository).toHaveBeenCalledWith(
      expect.objectContaining({ path: path.resolve(process.cwd()) }),
      {
        companionPath: expectedCompanionPath,
        companionSource: "git",
      },
    );
    expect(logs.join("\n")).toContain(`Companion: ${expectedCompanionPath}`);
  });

  test("falls back to the pasted HTTPS URL when the GitHub SSH clone fails", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const originalLog = console.log;
    console.log = () => {};

    const spawn = mock((command: string, args: string[]) => ({
      status: args[1] === "git@github.com:user/test-companion.git" ? 128 : 0,
      stderr: args[1] === "git@github.com:user/test-companion.git" ? "ssh failed" : "",
      stdout: "",
    }));
    const rm = mock(async () => {});

    try {
      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async () => ({
          source: "git",
          gitUrl: "https://github.com/user/test-companion.git",
          profile: "default",
        }),
        extractRepoName: () => "test-companion",
        resolveCompanion: async () => null,
        stat: async () => {
          throw new Error("ENOENT");
        },
        mkdir: async () => {},
        spawnSync: spawn as never,
        rm,
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        runSetupFlowAtPath: mock(async () => {}),
        installCompanion: async () => {},
        registerRepository: async (repository) => repository,
        registerCompanion: async () => {},
        detectInvokingEditorCli: () => null,
        injectEditorFolder: async () => true,
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      console.log = originalLog;
    }

    const expectedCompanionPath = path.join(
      path.join(process.env.HOME!, ".mate", "companions"),
      "test-companion",
    );
    expect(spawn.mock.calls.map((call) => call[1])).toEqual([
      ["clone", "git@github.com:user/test-companion.git", expectedCompanionPath],
      ["clone", "https://github.com/user/test-companion.git", expectedCompanionPath],
    ]);
    expect(rm).toHaveBeenCalledTimes(1);
  });

  test("links an existing companion and succeeds without editor injection in unsupported contexts", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => logs.push(String(msg ?? ""));

    const localCompanionPath = path.join(
      process.env.HOME!,
      ".mate",
      "companions",
      "local-companion",
    );
    const spawn = mockSpawnSync({ status: 0 });
    const runSetup = mock(async () => {});
    let selectedOptions: { existingCompanions?: string[] } | undefined;

    try {
      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async (options) => {
          selectedOptions = options;
          return {
            source: "existing",
            companionPaths: [localCompanionPath],
            profile: "default",
          };
        },
        resolveCompanion: async () => null,
        listCompanions: async () => [localCompanionPath],
        stat: async () => ({ isDirectory: () => true }) as Awaited<ReturnType<typeof fs.stat>>,
        spawnSync: spawn,
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        runSetupFlowAtPath: runSetup,
        installCompanion: async () => {},
        registerRepository: async (repository) => repository,
        registerCompanion: async () => {},
        detectInvokingEditorCli: () => null,
        injectEditorFolder: async () => true,
        openEditorWorkspace: () => true,
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      console.log = originalLog;
    }

    expect(spawn).not.toHaveBeenCalled();
    expect(runSetup).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(`Companion: ${path.resolve(localCompanionPath)}`);
    expect(logs.join("\n")).toContain("Source: git");
    expect(logs.join("\n")).toContain("manual open");
    expect(selectedOptions?.existingCompanions).toEqual([path.resolve(localCompanionPath)]);
  });

  test("allows linking another companion when the working repo is already linked", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const companionsDir = path.join(process.env.HOME!, ".mate", "companions");
    const firstCompanionPath = path.join(companionsDir, "first-companion");
    const secondCompanionPath = path.join(companionsDir, "second-companion");
    const registerRepository = mock(async (repository: LinkedRepository) => repository);
    const registerCompanion = mock(async () => {});

    try {
      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async (options) => {
          expect(options.existingCompanions).toContain(path.resolve(firstCompanionPath));
          return {
            source: "existing",
            companionPaths: [secondCompanionPath],
            profile: "default",
          };
        },
        resolveCompanion: async () => ({
          companionPath: firstCompanionPath,
          repositoryId: "working",
        }),
        listCompanions: async () => [firstCompanionPath, secondCompanionPath],
        stat: async () => ({ isDirectory: () => true }) as Awaited<ReturnType<typeof fs.stat>>,
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        registerRepository,
        registerCompanion,
        installCompanion: async () => {},
        detectInvokingEditorCli: () => null,
        injectEditorFolder: async () => true,
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    }

    expect(registerRepository).toHaveBeenCalledWith(
      expect.objectContaining({ path: path.resolve(process.cwd()) }),
      {
        companionPath: path.resolve(secondCompanionPath),
        companionSource: "git",
      },
    );
    expect(registerCompanion).toHaveBeenCalledWith(path.resolve(secondCompanionPath));
  });

  test("links a local companion outside the managed companions directory", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const localCompanionPath = path.join(
      process.env.TMPDIR ?? "/tmp",
      "mate-companion-from-local-path",
    );
    const registerRepository = mock(
      async (
        repository: LinkedRepository,
        options: { companionPath: string; companionSource: CompanionSource },
      ) => repository,
    );

    try {
      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async (options) => {
          expect(options.existingCompanions).toEqual([]);
          return {
            source: "local",
            localPath: localCompanionPath,
            profile: "default",
          };
        },
        resolveCompanion: async () => null,
        listCompanions: async () => [],
        stat: async () => ({ isDirectory: () => true }) as Awaited<ReturnType<typeof fs.stat>>,
        inspectSetupPreflight: async () => ({ kind: "unrecognized" }),
        runSetupFlowAtPath: mock(async () => {}),
        installCompanion: async () => {},
        registerRepository,
        registerCompanion: async () => {},
        detectInvokingEditorCli: () => null,
        injectEditorFolder: async () => true,
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    }

    expect(registerRepository).toHaveBeenCalledWith(
      expect.objectContaining({ path: path.resolve(process.cwd()) }),
      {
        companionPath: path.resolve(localCompanionPath),
        companionSource: "local",
      },
    );
  });

  test("falls back to opening both working repo and companion when editor injection fails", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => logs.push(String(msg ?? ""));

    const localCompanionPath = path.join(
      process.env.HOME!,
      ".mate",
      "companions",
      "local-companion",
    );
    const openWorkspace = mock(() => true);

    try {
      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async () => ({
          source: "existing",
          companionPaths: [localCompanionPath],
          profile: "default",
        }),
        resolveCompanion: async () => null,
        stat: async () => ({ isDirectory: () => true }) as Awaited<ReturnType<typeof fs.stat>>,
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        runSetupFlowAtPath: mock(async () => {}),
        installCompanion: async () => {},
        registerRepository: async (repository) => repository,
        registerCompanion: async () => {},
        detectInvokingEditorCli: () => "code",
        injectEditorFolder: async () => false,
        openEditorWorkspace: openWorkspace,
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      console.log = originalLog;
    }

    expect(openWorkspace).toHaveBeenCalledWith(
      [path.resolve(process.cwd()), path.resolve(localCompanionPath)],
      "code",
    );
    expect(logs.join("\n")).toContain("opened code with working repo and companion");
  });

  test("writes the workspace-local link metadata without requiring companion-side registry writes", async () => {
    const originalIsTTY = process.stdin.isTTY;
    const originalCwd = process.cwd();
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const root = await makeTempDir("mate-companion-link-");
    const companionPath = path.join(root, "companion");
    const workingPath = path.join(root, "working");

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => logs.push(String(msg ?? ""));

    try {
      await fs.mkdir(path.join(companionPath, `.${frameworkConfig.name}`, "config"), {
        recursive: true,
      });
      await fs.mkdir(workingPath, { recursive: true });
      await fs.writeFile(
        path.join(companionPath, `.${frameworkConfig.name}`, "config", "framework.yaml"),
        "type: companion\nprofiles:\n  default:\n    name: default\n    allowedAgents:\n      - claude\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(companionPath, `.${frameworkConfig.name}`, "config", "registry.yaml"),
        "repos: []\n",
        "utf8",
      );
      process.chdir(workingPath);

      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async () => ({
          source: "existing",
          companionPaths: [companionPath],
          profile: "default",
        }),
        resolveCompanion: async () => null,
        registerCompanion: async () => {},
        installCompanion: async () => {},
        detectInvokingEditorCli: () => null,
        injectEditorFolder: async () => true,
      });
      const workspaceRegistry = await fs.readFile(
        path.join(workingPath, `.${frameworkConfig.name}`, "config", "registry.yaml"),
        "utf8",
      );
      const workspaceFramework = await fs.readFile(
        path.join(workingPath, `.${frameworkConfig.name}`, "config", "framework.yaml"),
        "utf8",
      );
      const resolvedWorkingPath = await fs.realpath(workingPath);

      expect(workspaceRegistry).toContain("repository:");
      expect(workspaceRegistry).toContain("id: working");
      expect(workspaceRegistry).toContain(`path: ${resolvedWorkingPath}`);
      expect(workspaceRegistry).toContain(`- path: ${companionPath}`);
      expect(workspaceFramework).toContain("type: working");
      expect(logs.join("\n")).toContain(`Companion: ${companionPath}`);
    } finally {
      process.chdir(originalCwd);
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      console.log = originalLog;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("fails without a TTY", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    const { error } = await withProcessExitStub(() => runCompanionLinkCommandWithDeps([]));

    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    process.stderr.write = originalWrite;

    expect(String(error)).toContain("EXIT:1");
    expect(stderrChunks.join("")).toContain("requires a TTY");
  });
});
