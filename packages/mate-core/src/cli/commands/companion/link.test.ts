import { describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  companionLinkCommandDeps,
  runCompanionLinkCommand,
  runCompanionLinkCommandWithDeps,
} from "./link";
import type { CompanionLinkWizardOptions } from "../../companion-link-wizard";
import type { LinkedRepository } from "../../../lib/orchestrator/types";
import { FRAMEWORK_NAME } from "../../../framework";
import * as editor from "../../../lib/orchestrator/editor";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import {
  RepoLocalRegistryStore,
  writeRepoLocalFrameworkConfig,
} from "../../../lib/orchestrator/repo-local-store";
import {
  CompanionResolver,
  readCompanionRegistry,
} from "../../../lib/orchestrator/repository-link";
import { repoLocalRegistryPath } from "../../../runtime/repo-local";
import { createStartupProgress } from "../../../lib/components/startup-progress";

/** Plain progress whose lines the test reads back. */
function plainProgress() {
  const lines: string[] = [];
  const stdout = {
    isTTY: false,
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { lines, create: (title: string) => createStartupProgress(title, { stdout }) };
}

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

function mockClone(opts: { status: number; stderr?: string; stdout?: string }) {
  return mock(async (_url: string, _destination: string) => ({
    status: opts.status,
    stderr: opts.stderr ?? "",
    stdout: opts.stdout ?? "",
  }));
}

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", prefix));
}

async function runLinkWithShadowScan(
  findShadowedRegistries: () => Promise<string[]>,
): Promise<{ logs: string[]; errors: string[] }> {
  const originalIsTTY = process.stdin.isTTY;
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  const errors: string[] = [];
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  console.log = (msg?: unknown) => logs.push(String(msg ?? ""));
  console.error = (msg?: unknown) => errors.push(String(msg ?? ""));

  try {
    await runCompanionLinkCommandWithDeps([], {
      selectCompanionLinkInputs: async () => ({
        source: "existing",
        companionPaths: [path.join(process.env.HOME!, ".mate", "companions", "test-companion")],
      }),
      currentCompanions: async () => [],
      detectCompanionFolders: async () => [],
      listCompanions: async () => [],
      stat: async () => ({ isDirectory: () => true }) as Awaited<ReturnType<typeof fs.stat>>,
      inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
      installCompanion: async () => {},
      registerRepository: async (repository) => repository,
      registerCompanion: async () => {},
      findDescendantRepoLocalRegistries: findShadowedRegistries,
    });
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    console.log = originalLog;
    console.error = originalError;
  }

  return { logs, errors };
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
  test("prints no warning when no descendant links are found", async () => {
    const { logs, errors } = await runLinkWithShadowScan(async () => []);

    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain("Successfully linked companion");
  });

  test("warns with every descendant link while still reporting success", async () => {
    const shadowedPaths = ["/workspace/working-a", "/workspace/nested/working-b"];
    const { logs, errors } = await runLinkWithShadowScan(async () => shadowedPaths);

    expect(errors.join("\n")).toContain("existing companion links will shadow this new link");
    for (const shadowedPath of shadowedPaths) {
      expect(errors.join("\n")).toContain(shadowedPath);
    }
    expect(errors.join("\n")).toContain(
      "Mate commands run from inside these directories will keep resolving to their existing link",
    );
    expect(logs.join("\n")).toContain("Successfully linked companion");
  });

  test("continues successfully when the descendant scan fails", async () => {
    const { logs, errors } = await runLinkWithShadowScan(async () => {
      throw new Error("scan failed");
    });

    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain("Successfully linked companion");
  });

  test("clones git-backed companions, bootstraps setup, registers source provenance, and injects the workspace", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => logs.push(String(msg ?? ""));

    const registerRepository = mock(async (repository: LinkedRepository) => repository);
    const runSetup = mock(async () => {});
    const installCompanion = mock(async () => {});
    const clone = mockClone({ status: 0 });
    const progress = plainProgress();

    try {
      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async () => ({
          source: "git",
          gitUrl: "https://github.com/user/test-companion.git",
        }),
        extractRepoName: () => "test-companion",
        currentCompanions: async () => [],
        detectCompanionFolders: async () => [],
        stat: async () => {
          throw new Error("ENOENT");
        },
        mkdir: async () => {},
        cloneCompanion: clone,
        inspectSetupPreflight: async () => ({ kind: "unrecognized" }),
        runSetupFlowAtPath: runSetup,
        installCompanion,
        registerRepository,
        registerCompanion: async () => {},
        createProgress: progress.create,
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      console.log = originalLog;
    }

    const expectedCompanionPath = path.join(
      path.join(process.env.HOME!, ".mate", "companions"),
      "test-companion",
    );
    expect(progress.lines).toEqual([
      "mate · Linking companion\n",
      "  Cloning companion\n",
      "  ✓ Cloning companion\n",
    ]);
    expect(clone).toHaveBeenCalledWith(
      "https://github.com/user/test-companion.git",
      expectedCompanionPath,
    );
    expect(runSetup).toHaveBeenCalledWith(expectedCompanionPath);
    expect(installCompanion).toHaveBeenCalledWith(expectedCompanionPath);
    expect(registerRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        id: path.basename(process.cwd()),
        path: path.resolve(process.cwd()),
      }),
      {
        companionPath: expectedCompanionPath,
        companionSource: "git",
      },
    );
    expect(logs.join("\n")).toContain(
      "Workspace: run `mate companion open` to open the workspace in your editor",
    );
  });

  test("uses the repository name from an explicit ssh URL", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const originalLog = console.log;
    console.log = () => {};

    const clone = mockClone({ status: 0 });

    try {
      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async () => ({
          source: "git",
          gitUrl: "ssh://git@git.example.test:22222/example-org/example-group/acme-companion.git",
        }),
        currentCompanions: async () => [],
        detectCompanionFolders: async () => [],
        stat: async () => {
          throw new Error("ENOENT");
        },
        mkdir: async () => {},
        cloneCompanion: clone,
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        installCompanion: async () => {},
        registerRepository: async (repository) => repository,
        registerCompanion: async () => {},
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      console.log = originalLog;
    }

    const expectedCompanionPath = path.join(
      path.join(process.env.HOME!, ".mate", "companions"),
      "acme-companion",
    );
    expect(clone).toHaveBeenCalledWith(
      "ssh://git@git.example.test:22222/example-org/example-group/acme-companion.git",
      expectedCompanionPath,
    );
  });

  test("reuses an existing git companion directory instead of failing or recloning", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => logs.push(String(msg ?? ""));

    const registerRepository = mock(async (repository: LinkedRepository) => repository);
    const runSetup = mock(async () => {});
    const clone = mockClone({ status: 0 });

    try {
      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async () => ({
          source: "git",
          gitUrl: "https://github.com/user/test-companion.git",
        }),
        extractRepoName: () => "test-companion",
        currentCompanions: async () => [],
        detectCompanionFolders: async () => [],
        stat: async (candidatePath: string) =>
          ({
            isDirectory: () =>
              candidatePath.endsWith(path.join(".mate", "companions", "test-companion")),
          }) as Awaited<ReturnType<typeof fs.stat>>,
        mkdir: async () => {},
        readOrigin: () => "git@github.com:user/test-companion.git",
        cloneCompanion: clone,
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        runSetupFlowAtPath: runSetup,
        installCompanion: async () => {},
        registerRepository,
        registerCompanion: async () => {},
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      console.log = originalLog;
    }

    const expectedCompanionPath = path.join(
      path.join(process.env.HOME!, ".mate", "companions"),
      "test-companion",
    );
    expect(clone).not.toHaveBeenCalled();
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

  test("reports a failed clone and registers nothing", async () => {
    const progress = plainProgress();
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const originalStderrWrite = process.stderr.write;
    const stderr: string[] = [];
    process.stderr.write = ((chunk: string) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const registerRepository = mock(async (repository: LinkedRepository) => repository);

    try {
      const { error } = await withProcessExitStub(() =>
        runCompanionLinkCommandWithDeps([], {
          selectCompanionLinkInputs: async () => ({
            source: "git",
            gitUrl: "https://example.test/acme/acme-companion.git",
          }),
          currentCompanions: async () => [],
          detectCompanionFolders: async () => [],
          stat: async () => {
            throw new Error("ENOENT");
          },
          mkdir: async () => {},
          cloneCompanion: mockClone({ status: 128, stderr: "fatal: repository not found" }),
          registerRepository,
          registerCompanion: async () => {},
          createProgress: progress.create,
        }),
      );
      expect(String(error)).toContain("EXIT:1");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      process.stderr.write = originalStderrWrite;
    }

    expect(progress.lines).toEqual([
      "mate · Linking companion\n",
      "  Cloning companion\n",
      "  ✗ Cloning companion failed\n",
    ]);
    expect(stderr.join("")).toContain("failed to clone companion repository");
    expect(stderr.join("")).toContain("repository not found");
    expect(registerRepository).not.toHaveBeenCalled();
  });

  test("links an existing companion and succeeds without touching the editor", async () => {
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
    const clone = mockClone({ status: 0 });
    const runSetup = mock(async () => {});
    let selectedOptions: { existingCompanions?: string[] } | undefined;

    try {
      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async (options) => {
          selectedOptions = options;
          return {
            source: "existing",
            companionPaths: [localCompanionPath],
          };
        },
        currentCompanions: async () => [],
        detectCompanionFolders: async () => [],
        listCompanions: async () => [localCompanionPath],
        stat: async () => ({ isDirectory: () => true }) as Awaited<ReturnType<typeof fs.stat>>,
        cloneCompanion: clone,
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        runSetupFlowAtPath: runSetup,
        installCompanion: async () => {},
        registerRepository: async (repository) => repository,
        registerCompanion: async () => {},
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      console.log = originalLog;
    }

    expect(clone).not.toHaveBeenCalled();
    expect(runSetup).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(`Companion: ${path.resolve(localCompanionPath)}`);
    expect(logs.join("\n")).toContain("Source: git");
    expect(logs.join("\n")).toContain(
      "Workspace: run `mate companion open` to open the workspace in your editor",
    );
    expect(selectedOptions?.existingCompanions).toEqual([
      { path: path.resolve(localCompanionPath), registered: true },
    ]);
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
          expect(options.existingCompanions?.map((companion) => companion.path)).toContain(
            path.resolve(firstCompanionPath),
          );
          return {
            source: "existing",
            companionPaths: [secondCompanionPath],
            replace: false,
          };
        },
        currentCompanions: async () => [firstCompanionPath],
        detectCompanionFolders: async () => [],
        listCompanions: async () => [firstCompanionPath, secondCompanionPath],
        stat: async () => ({ isDirectory: () => true }) as Awaited<ReturnType<typeof fs.stat>>,
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        registerRepository,
        registerCompanion,
        installCompanion: async () => {},
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
    const registerRepository = mock(async (repository: LinkedRepository) => repository);

    try {
      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async (options) => {
          expect(options.existingCompanions).toEqual([]);
          return {
            source: "local",
            localPath: localCompanionPath,
          };
        },
        currentCompanions: async () => [],
        detectCompanionFolders: async () => [],
        listCompanions: async () => [],
        stat: async () => ({ isDirectory: () => true }) as Awaited<ReturnType<typeof fs.stat>>,
        inspectSetupPreflight: async () => ({ kind: "unrecognized" }),
        runSetupFlowAtPath: mock(async () => {}),
        installCompanion: async () => {},
        registerRepository,
        registerCompanion: async () => {},
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

  test("never touches the editor, even inside a VS Code or Cursor session", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const localCompanionPath = path.join(
      process.env.HOME!,
      ".mate",
      "companions",
      "local-companion",
    );

    const detectInvokingEditorCli = spyOn(editor, "detectInvokingEditorCli").mockReturnValue(
      "cursor",
    );
    const openEditorWorkspace = spyOn(editor, "openEditorWorkspace");
    const originalTermProgram = process.env.TERM_PROGRAM;
    process.env.TERM_PROGRAM = "cursor";

    try {
      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async () => ({
          source: "existing",
          companionPaths: [localCompanionPath],
        }),
        currentCompanions: async () => [],
        detectCompanionFolders: async () => [],
        stat: async () => ({ isDirectory: () => true }) as Awaited<ReturnType<typeof fs.stat>>,
        inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
        runSetupFlowAtPath: mock(async () => {}),
        installCompanion: async () => {},
        registerRepository: async (repository) => repository,
        registerCompanion: async () => {},
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      process.env.TERM_PROGRAM = originalTermProgram;
    }

    expect(detectInvokingEditorCli).not.toHaveBeenCalled();
    expect(openEditorWorkspace).not.toHaveBeenCalled();
  });

  test("writes both the repo-local pointer and the companion-side registry entry", async () => {
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
      await fs.mkdir(path.join(companionPath, `.${FRAMEWORK_NAME}`, "config"), {
        recursive: true,
      });
      await fs.mkdir(workingPath, { recursive: true });
      await fs.writeFile(
        path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
        "type: companion\nallowedAgents:\n  - claude\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "registry.yaml"),
        "repos: []\n",
        "utf8",
      );
      process.chdir(workingPath);

      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async () => ({
          source: "existing",
          companionPaths: [companionPath],
        }),
        currentCompanions: async () => [],
        detectCompanionFolders: async () => [],
        registerCompanion: async () => {},
        installCompanion: async () => {},
      });
      const workspaceRegistry = await fs.readFile(
        path.join(workingPath, `.${FRAMEWORK_NAME}`, "config", "registry.yaml"),
        "utf8",
      );
      const workspaceFramework = await fs.readFile(
        path.join(workingPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
        "utf8",
      );
      const companionRegistry = await fs.readFile(
        path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "registry.yaml"),
        "utf8",
      );
      const resolvedWorkingPath = await fs.realpath(workingPath);

      expect(workspaceRegistry).toContain("repository:");
      expect(workspaceRegistry).toContain("id: working");
      expect(workspaceRegistry).toContain(`path: ${resolvedWorkingPath}`);
      expect(workspaceRegistry).toContain(`- path: ${companionPath}`);
      expect(workspaceFramework).toContain("type: working");
      expect(companionRegistry).toContain("id: working");
      expect(companionRegistry).toContain(`path: ${resolvedWorkingPath}`);
      expect(logs.join("\n")).toContain(`Companion: ${companionPath}`);
    } finally {
      process.chdir(originalCwd);
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
      console.log = originalLog;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("creates the companion-side registry when linking a companion that has never had one", async () => {
    const originalIsTTY = process.stdin.isTTY;
    const originalCwd = process.cwd();
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const root = await makeTempDir("mate-companion-link-fresh-");
    const companionPath = path.join(root, "companion");
    const workingPath = path.join(root, "working");

    try {
      // Mirrors a companion set up before the companion-side registry write
      // existed: framework.yaml present, no registry.yaml at all.
      await fs.mkdir(path.join(companionPath, `.${FRAMEWORK_NAME}`, "config"), {
        recursive: true,
      });
      await fs.mkdir(workingPath, { recursive: true });
      await fs.writeFile(
        path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
        "type: companion\nallowedAgents:\n  - claude\n",
        "utf8",
      );
      process.chdir(workingPath);

      await runCompanionLinkCommandWithDeps([], {
        selectCompanionLinkInputs: async () => ({
          source: "existing",
          companionPaths: [companionPath],
        }),
        currentCompanions: async () => [],
        detectCompanionFolders: async () => [],
        registerCompanion: async () => {},
        installCompanion: async () => {},
      });

      const companionRegistry = await fs.readFile(
        path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "registry.yaml"),
        "utf8",
      );
      const resolvedWorkingPath = await fs.realpath(workingPath);

      expect(companionRegistry).toContain("id: working");
      expect(companionRegistry).toContain(`path: ${resolvedWorkingPath}`);
    } finally {
      process.chdir(originalCwd);
      Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
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

type LinkDeps = NonNullable<Parameters<typeof runCompanionLinkCommandWithDeps>[1]>;

/** Runs a link from `cwd` with a TTY, capturing output and a `process.exit`. */
async function runLinkIn(cwd: string | null, deps: LinkDeps) {
  const originalIsTTY = process.stdin.isTTY;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalStderrWrite = process.stderr.write;
  const logs: string[] = [];
  const errors: string[] = [];
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  console.log = (msg?: unknown) => logs.push(String(msg ?? ""));
  console.error = (msg?: unknown) => errors.push(String(msg ?? ""));
  process.stderr.write = ((chunk: string) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  if (cwd) process.chdir(cwd);
  try {
    const { error } = await withProcessExitStub(() => runCompanionLinkCommandWithDeps([], deps));
    return { logs, errors, error };
  } finally {
    process.chdir(originalCwd);
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    console.log = originalLog;
    console.error = originalError;
    process.stderr.write = originalStderrWrite;
  }
}

const directoryStat = (directories: string[]) => async (candidate: string) => {
  if (!directories.includes(candidate)) throw new Error("ENOENT");
  return { isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>;
};

async function writeCompanion(companionPath: string, repos: string[] = []): Promise<void> {
  const configDir = path.join(companionPath, `.${FRAMEWORK_NAME}`, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "framework.yaml"), "type: companion\n", "utf8");
  const entries = repos.map((repo) => `  - id: working\n    path: ${repo}\n`).join("");
  await fs.writeFile(
    path.join(configDir, "registry.yaml"),
    repos.length ? `repos:\n${entries}` : "repos: []\n",
    "utf8",
  );
}

/** `working` linked to `old-companion`, with `new-companion` beside it. */
async function linkedToOldCompanion() {
  const root = await fs.realpath(await makeTempDir("mate-companion-relink-"));
  const working = path.join(root, "working");
  const oldCompanion = path.join(root, "old-companion");
  const newCompanion = path.join(root, "new-companion");
  await fs.mkdir(working, { recursive: true });
  await writeCompanion(oldCompanion, [working]);
  await writeCompanion(newCompanion);
  await new RepoLocalRegistryStore(repoLocalRegistryPath(working)).save({
    repository: { id: "working", path: working },
    companions: [{ path: oldCompanion, repositoryId: "working", source: "local" }],
  });
  return { root, working, oldCompanion, newCompanion };
}

/** Tests that read the real link pass `currentCompanions: undefined`. */
const quietLinkDeps: LinkDeps = {
  currentCompanions: async () => [],
  listCompanions: async () => [],
  detectCompanionFolders: async () => [],
  inspectSetupPreflight: async () => ({ kind: "existing-companion" }),
  installCompanion: async () => {},
  registerCompanion: async () => {},
};

describe("companion link choice", () => {
  test("offers every registered companion that still exists, wherever it lives", async () => {
    let offered: CompanionLinkWizardOptions["existingCompanions"];
    await runLinkIn(null, {
      ...quietLinkDeps,
      listCompanions: async () => ["/work/acme-companion", "/work/gone-companion"],
      stat: directoryStat(["/work/acme-companion"]),
      selectCompanionLinkInputs: async (options) => {
        offered = options.existingCompanions;
        return null;
      },
    });

    expect(offered).toEqual([{ path: "/work/acme-companion", registered: true }]);
  });

  test("offers an unregistered companion next to the working repositories and registers it when chosen", async () => {
    const root = await fs.realpath(await makeTempDir("mate-companion-detect-"));
    const work = path.join(root, "work");
    const companion = path.join(work, "acme-companion");
    try {
      await writeCompanion(companion);
      await writeRepoLocalFrameworkConfig(path.join(work, "acme-app"));
      const registerCompanion = mock(async () => {});
      const registerRepository = mock(async (repository: LinkedRepository) => repository);
      let offered: CompanionLinkWizardOptions["existingCompanions"];

      await runLinkIn(work, {
        ...quietLinkDeps,
        detectCompanionFolders: undefined,
        currentCompanions: async () => [],
        registerCompanion,
        registerRepository,
        selectCompanionLinkInputs: async (options) => {
          offered = options.existingCompanions;
          return { source: "existing", companionPaths: [companion] };
        },
      });

      expect(offered).toEqual([{ path: companion, registered: false }]);
      expect(registerCompanion).toHaveBeenCalledWith(companion);
      expect(registerRepository).toHaveBeenCalledWith(expect.objectContaining({ path: work }), {
        companionPath: companion,
        companionSource: "local",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("links a clone already on the machine instead of cloning the URL", async () => {
    const clone = mockClone({ status: 0 });
    const registerRepository = mock(async (repository: LinkedRepository) => repository);
    const url = "https://example.com/acme/acme-companion.git";

    await runLinkIn(null, {
      ...quietLinkDeps,
      detectCompanionFolders: async () => ["/work/acme-companion"],
      stat: directoryStat(["/work/acme-companion"]),
      readOrigin: () => "git@example.com:acme/acme-companion.git",
      cloneCompanion: clone,
      registerRepository,
      selectCompanionLinkInputs: async (options) => {
        expect(options.clonesOf?.(url)).toEqual(["/work/acme-companion"]);
        expect(options.clonesOf?.("https://example.com/acme/other.git")).toEqual([]);
        return { source: "git", gitUrl: url, clonePath: "/work/acme-companion" };
      },
    });

    expect(clone).not.toHaveBeenCalled();
    expect(registerRepository).toHaveBeenCalledWith(expect.anything(), {
      companionPath: "/work/acme-companion",
      companionSource: "local",
    });
  });

  test("refuses a managed companion folder that holds another repository, before any write", async () => {
    const managed = path.join(process.env.HOME!, ".mate", "companions", "acme-companion");
    const registerRepository = mock(async (repository: LinkedRepository) => repository);
    const registerCompanion = mock(async () => {});
    const url = "https://example.com/acme/acme-companion.git";

    const { errors, error } = await runLinkIn(null, {
      ...quietLinkDeps,
      stat: directoryStat([managed]),
      readOrigin: () => "https://example.com/other/acme-companion.git",
      cloneCompanion: mockClone({ status: 0 }),
      registerRepository,
      registerCompanion,
      selectCompanionLinkInputs: async () => ({ source: "git", gitUrl: url }),
    });

    expect(String(error)).toContain("EXIT:1");
    const message = errors.join("");
    expect(message).toContain(managed);
    expect(message).toContain("https://example.com/other/acme-companion.git");
    expect(message).toContain(url);
    expect(registerRepository).not.toHaveBeenCalled();
    expect(registerCompanion).not.toHaveBeenCalled();
  });

  test("Replace leaves only the chosen companion linked", async () => {
    const { root, working, oldCompanion, newCompanion } = await linkedToOldCompanion();
    try {
      await runLinkIn(working, {
        ...quietLinkDeps,
        currentCompanions: undefined,
        selectCompanionLinkInputs: async (options) => {
          expect(
            options.replacedBy?.({ source: "existing", companionPaths: [oldCompanion] }),
          ).toEqual([]);
          return { source: "existing", companionPaths: [newCompanion], replace: true };
        },
      });

      const local = await new RepoLocalRegistryStore(repoLocalRegistryPath(working)).load();
      expect(local.companions.map((pointer) => pointer.path)).toEqual([newCompanion]);
      expect((await readCompanionRegistry(oldCompanion)).repos).toEqual([]);
      const resolution = await new CompanionResolver(
        new GlobalConfigStore(),
      ).resolveWithDiagnostics(working, { write: false });
      expect(resolution.match?.companionPath).toBe(newCompanion);
      expect(resolution.ambiguousMatches).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("does not offer Replace for a link inherited from an ancestor folder", async () => {
    const { root, working, newCompanion } = await linkedToOldCompanion();
    const subfolder = path.join(working, "packages", "sub");
    try {
      await fs.mkdir(subfolder, { recursive: true });
      let replaced: string[] | undefined;
      await runLinkIn(subfolder, {
        ...quietLinkDeps,
        currentCompanions: undefined,
        selectCompanionLinkInputs: async (options) => {
          replaced = options.replacedBy?.({ source: "existing", companionPaths: [newCompanion] });
          return null;
        },
      });

      expect(replaced).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the old link when the new link fails after Replace", async () => {
    const { root, working, oldCompanion, newCompanion } = await linkedToOldCompanion();
    try {
      const { error } = await runLinkIn(working, {
        ...quietLinkDeps,
        currentCompanions: undefined,
        registerRepository: async () => {
          throw new Error("another mate process is still writing registry.yaml; try again.");
        },
        selectCompanionLinkInputs: async () => ({
          source: "existing",
          companionPaths: [newCompanion],
          replace: true,
        }),
      });

      expect(String(error)).toContain("try again");
      const local = await new RepoLocalRegistryStore(repoLocalRegistryPath(working)).load();
      expect(local.companions.map((pointer) => pointer.path)).toEqual([oldCompanion]);
      expect((await readCompanionRegistry(oldCompanion)).repos.map((repo) => repo.path)).toEqual([
        working,
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("Keep both keeps the current companion linked", async () => {
    const { root, working, oldCompanion, newCompanion } = await linkedToOldCompanion();
    try {
      await runLinkIn(working, {
        ...quietLinkDeps,
        currentCompanions: undefined,
        selectCompanionLinkInputs: async () => ({
          source: "existing",
          companionPaths: [newCompanion],
          replace: false,
        }),
      });

      const local = await new RepoLocalRegistryStore(repoLocalRegistryPath(working)).load();
      expect(local.companions.map((pointer) => pointer.path)).toEqual([oldCompanion, newCompanion]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("completes a Replace with a warning when the old companion's registry cannot be written", async () => {
    const removeRepoLocalPointer = mock(async () => {});
    const registerRepository = mock(async (repository: LinkedRepository) => repository);

    const { logs, errors } = await runLinkIn(null, {
      ...quietLinkDeps,
      currentCompanions: async () => ["/work/old-companion"],
      stat: directoryStat(["/work/old-companion", "/work/new-companion"]),
      removeRepoLocalPointer,
      removeCompanionRepository: async () => {
        throw new Error("EACCES: permission denied");
      },
      registerRepository,
      selectCompanionLinkInputs: async () => ({
        source: "existing",
        companionPaths: ["/work/new-companion"],
        replace: true,
      }),
    });

    expect(removeRepoLocalPointer).toHaveBeenCalledWith(
      path.resolve(process.cwd()),
      "/work/old-companion",
    );
    expect(errors.join("\n")).toContain("/work/old-companion");
    expect(registerRepository).toHaveBeenCalledWith(expect.anything(), {
      companionPath: "/work/new-companion",
      companionSource: "local",
    });
    expect(logs.join("\n")).toContain("Successfully linked companion");
  });
});
