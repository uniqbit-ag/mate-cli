import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("@opencode-ai/plugin", () => ({ tool: (definition: unknown) => definition }));

const { CompanionHooksPlugin } = await import("./companion-hooks");
const { MATE_ENV } = await import("../runtime/env-names");
const { writeProjectionPair } = await import("../runtime/projection");
const { repoLocalRegistryPath } = await import("../runtime/repo-local");
const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Every launch variable cleared: `hasLaunchEnvironment` counts any of them as a launch. */
function noLaunchEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(Object.values(MATE_ENV).map((name) => [name, undefined]));
}

async function wrapRepo(repoRoot: string, companionPath: string): Promise<void> {
  const registryPath = repoLocalRegistryPath(repoRoot);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, "companions: []\n", "utf8");
  writeProjectionPair(repoRoot, {
    stamp: "deadbeef",
    projection: {
      version: "0.0.0",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme",
      wrapperBinPath: path.join(companionPath, "wrappers", "bin"),
      reactDoctorBinPath: path.join(companionPath, "react-doctor"),
      graphifyOut: path.join(companionPath, ".graphify", "acme", "graphify-out"),
    },
  });
}

async function inDirectory<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("OpenCode companion hooks plugin without a launch", () => {
  test("activates from a projection and blocks an artifact write", async () => {
    const repo = await makeTempDir("mate-hooks-wrapped-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await wrapRepo(repo, companion);

    const plugin = await withEnv(noLaunchEnvironment(), () =>
      inDirectory(repo, () => CompanionHooksPlugin()),
    );

    const before = plugin["tool.execute.before"]!;
    await expect(
      before(
        { tool: "write", sessionID: "s", callID: "c" },
        { args: { filePath: path.join(repo, "design.md") } },
      ),
    ).rejects.toThrow("artifact writes must go to the companion framework path");
  });

  test("fails open when neither the environment nor a projection resolves", async () => {
    const repo = await makeTempDir("mate-hooks-unwrapped-");

    const plugin = await withEnv(noLaunchEnvironment(), () =>
      inDirectory(repo, () => CompanionHooksPlugin()),
    );

    expect(plugin).toEqual({});
  });
});

describe("OpenCode companion hooks plugin", () => {
  async function setupCompanion() {
    const root = await makeTempDir("mate-opencode-companion-");
    const companion = path.join(root, "companion");
    const repo = path.join(root, "repo");
    const archiveDir = path.join(companion, "openspec", "changes", "archive");
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.mkdir(repo, { recursive: true });
    return { companion, repo, archiveDir };
  }

  async function getHooks(companion: string, repo: string, autoMode = "1") {
    return withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: autoMode,
      },
      () => CompanionHooksPlugin(),
    );
  }

  function makeReactDoctorRuntime(
    result: Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>,
  ) {
    const shellCalls: Array<{ strings: string[]; expressions: unknown[] }> = [];
    const shell = (strings: TemplateStringsArray, ...expressions: unknown[]) => {
      shellCalls.push({ strings: [...strings], expressions });
      const command = {
        cwd: () => command,
        nothrow: () => command,
        quiet: () => result,
      };
      return command;
    };
    const showToast = mock(async () => true);
    const promptAsync = mock(async () => undefined);
    const client = { tui: { showToast }, session: { promptAsync } };
    return { shell, shellCalls, client, showToast, promptAsync };
  }

  async function getReactDoctorHooks(
    companion: string,
    repo: string,
    runtime: ReturnType<typeof makeReactDoctorRuntime>,
  ) {
    return withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
        MATE_REACT_DOCTOR_ENABLED: "1",
      },
      () => CompanionHooksPlugin({ client: runtime.client, $: runtime.shell } as never),
    );
  }

  test("uses the Mate-owned React Doctor executable when no repo binary exists", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-react-doctor-runtime-");
    const mateBin = path.join(await makeTempDir("mate-opencode-react-doctor-bin-"), "react-doctor");
    await fs.writeFile(mateBin, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(mateBin, 0o755);
    const runtime = makeReactDoctorRuntime(
      Promise.resolve({ exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") }),
    );

    await withEnv({ MATE_REACT_DOCTOR_BIN_PATH: mateBin }, async () => {
      const plugin = await getReactDoctorHooks(companion, repo, runtime);
      await plugin["tool.execute.after"]!(
        { tool: "edit", sessionID: "one", callID: "call", args: {} },
        { title: "", output: "", metadata: {} },
      );
      await plugin.event!({
        event: { type: "session.idle", properties: { sessionID: "one" } },
      } as never);
    });

    expect(runtime.shellCalls[0]?.expressions.flat()).toContain(mateBin);
  });

  test("nudges only for an archive entry created during the tool call", async () => {
    const { companion, repo, archiveDir } = await setupCompanion();
    const output = { title: "", output: "", metadata: {} };
    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "1",
      },
      async () => {
        const plugin = await CompanionHooksPlugin();
        const before = plugin["tool.execute.before"]!;
        const after = plugin["tool.execute.after"]!;
        await before({ tool: "read", sessionID: "session", callID: "call" }, { args: {} });
        await fs.mkdir(path.join(archiveDir, "2026-07-14-my-change"));
        await after({ tool: "read", sessionID: "session", callID: "call", args: {} }, output);
      },
    );
    expect(output.output).toContain("mate-artifact-finish");
    expect(output.output).toContain("my-change");
    expect(output.output).toContain("without asking for confirmation");
    expect(output.output?.match(/ACTION REQUIRED:/g)).toHaveLength(1);
  });

  test("does not nudge for an archive entry created before the tool call", async () => {
    const { companion, repo, archiveDir } = await setupCompanion();
    const plugin = await getHooks(companion, repo);
    const output = { title: "", output: "", metadata: {} };

    await fs.mkdir(path.join(archiveDir, "2026-07-14-external-change"));
    await plugin["tool.execute.before"]!(
      { tool: "read", sessionID: "session", callID: "call" },
      { args: {} },
    );
    await plugin["tool.execute.after"]!(
      { tool: "read", sessionID: "session", callID: "call", args: {} },
      output,
    );

    expect(output.output).toBe("");
  });

  test("keeps overlapping tool-call snapshots independent", async () => {
    const { companion, repo, archiveDir } = await setupCompanion();
    const plugin = await getHooks(companion, repo);
    const before = plugin["tool.execute.before"]!;
    const after = plugin["tool.execute.after"]!;
    const firstOutput = { title: "", output: "", metadata: {} };
    const secondOutput = { title: "", output: "", metadata: {} };

    await before({ tool: "read", sessionID: "one", callID: "first" }, { args: {} });
    await before({ tool: "read", sessionID: "two", callID: "second" }, { args: {} });
    await fs.mkdir(path.join(archiveDir, "2026-07-14-my-change"));
    await after({ tool: "read", sessionID: "one", callID: "first", args: {} }, firstOutput);
    await after({ tool: "read", sessionID: "two", callID: "second", args: {} }, secondOutput);

    expect(firstOutput.output).toContain("my-change");
    expect(secondOutput.output).toContain("my-change");
  });

  test("discards pending snapshots when their session is deleted", async () => {
    const { companion, repo, archiveDir } = await setupCompanion();
    const plugin = await getHooks(companion, repo);
    const output = { title: "", output: "", metadata: {} };

    await plugin["tool.execute.before"]!(
      { tool: "read", sessionID: "session", callID: "call" },
      { args: {} },
    );
    await plugin.event!({
      event: { type: "session.deleted", properties: { info: { id: "session" } } },
    } as never);
    await fs.mkdir(path.join(archiveDir, "2026-07-14-external-change"));
    await plugin["tool.execute.after"]!(
      { tool: "read", sessionID: "session", callID: "call", args: {} },
      output,
    );

    expect(output.output).toBe("");
  });

  test("discards pending snapshots when the plugin is disposed", async () => {
    const { companion, repo, archiveDir } = await setupCompanion();
    const plugin = await getHooks(companion, repo);
    const output = { title: "", output: "", metadata: {} };

    await plugin["tool.execute.before"]!(
      { tool: "read", sessionID: "session", callID: "call" },
      { args: {} },
    );
    await plugin.dispose!();
    await fs.mkdir(path.join(archiveDir, "2026-07-14-external-change"));
    await plugin["tool.execute.after"]!(
      { tool: "read", sessionID: "session", callID: "call", args: {} },
      output,
    );

    expect(output.output).toBe("");
  });

  test("nudges after a direct archive command", async () => {
    const { companion, repo } = await setupCompanion();
    const output = { title: "", output: "", metadata: {} };
    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "1",
      },
      async () => {
        const plugin = await CompanionHooksPlugin();
        await plugin["tool.execute.after"]!(
          {
            tool: "bash",
            sessionID: "session",
            callID: "call",
            args: { command: "openspec archive my-change --json --yes" },
          },
          output,
        );
      },
    );
    expect(output.output).toContain("my-change");
  });

  test("nudges after a move command and ignores non-archive names", async () => {
    const { companion, repo } = await setupCompanion();
    const output = { title: "", output: "", metadata: {} };
    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "1",
      },
      async () => {
        const plugin = await CompanionHooksPlugin();
        await plugin["tool.execute.after"]!(
          {
            tool: "bash",
            sessionID: "session",
            callID: "call",
            args: { command: 'mv "my-change" "openspec/changes/archive/2026-07-14-my-change"' },
          },
          output,
        );
      },
    );
    expect(output.output).toContain("my-change");
  });

  test("does not nudge initial entries or disabled auto mode", async () => {
    const { companion, repo, archiveDir } = await setupCompanion();
    await fs.mkdir(path.join(archiveDir, "2026-07-14-existing-change"));
    const output = { title: "", output: "", metadata: {} };
    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "1",
      },
      async () => {
        const plugin = await CompanionHooksPlugin();
        await plugin["tool.execute.before"]!(
          { tool: "bash", sessionID: "session", callID: "call" },
          { args: {} },
        );
        await plugin["tool.execute.after"]!(
          { tool: "bash", sessionID: "session", callID: "call", args: {} },
          output,
        );
      },
    );
    expect(output.output).toBe("");
    const disabled = await getHooks(companion, repo, "0");
    expect(disabled["tool.execute.after"]).toBeDefined();
  });

  async function setupRepoFixture(prefix: string) {
    const root = await makeTempDir(prefix);
    const repo = path.join(root, "repo");
    const companion = path.join(root, "companion");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(companion, { recursive: true });
    spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    return { repo, companion };
  }

  test("blocks artifact writes and allows source writes", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-before-");
    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        const plugin = await CompanionHooksPlugin();
        const before = plugin["tool.execute.before"] as (
          input: { tool: string },
          output: { args: Record<string, unknown> },
        ) => Promise<void>;
        await expect(
          before({ tool: "write" }, { args: { filePath: path.join(repo, "spec.md") } }),
        ).rejects.toThrow("guardrail");
        await expect(
          before({ tool: "write" }, { args: { filePath: path.join(repo, "src", "main.ts") } }),
        ).resolves.toBeUndefined();
      },
    );
  });

  test("blocks artifact paths in apply_patch", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-patch-");
    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        const plugin = await CompanionHooksPlugin();
        const before = plugin["tool.execute.before"] as (
          input: { tool: string },
          output: { args: Record<string, unknown> },
        ) => Promise<void>;
        await expect(
          before(
            { tool: "apply_patch" },
            { args: { patchText: "*** Add File: spec.md\ncontent" } },
          ),
        ).rejects.toThrow("guardrail");
        await expect(
          before(
            { tool: "apply_patch" },
            { args: { patchText: "*** Add File: src/main.ts\ncontent" } },
          ),
        ).resolves.toBeUndefined();
      },
    );
  });

  test("allows gitignored artifact writes", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-gitignore-");
    await fs.writeFile(path.join(repo, ".gitignore"), "local-notes.md\n", "utf8");
    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        const plugin = await CompanionHooksPlugin();
        const before = plugin["tool.execute.before"] as (
          input: { tool: string },
          output: { args: Record<string, unknown> },
        ) => Promise<void>;
        await expect(
          before({ tool: "write" }, { args: { filePath: path.join(repo, "local-notes.md") } }),
        ).resolves.toBeUndefined();
      },
    );
  });

  test("allows apply_patch with no artifact paths", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-patch-ok-");
    await withEnv(
      {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "app",
        MATE_POLICY_JSON: "{}",
        MATE_GIT_AUTO_MODE: "0",
      },
      async () => {
        const plugin = await CompanionHooksPlugin();
        const before = plugin["tool.execute.before"] as (
          input: { tool: string },
          output: { args: Record<string, unknown> },
        ) => Promise<void>;
        await expect(
          before(
            { tool: "apply_patch" },
            { args: { patchText: "*** Add File: src/main.ts\ncontent" } },
          ),
        ).resolves.toBeUndefined();
      },
    );
  });

  test("runs one bounded scan only after a successful edit", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-react-doctor-");
    const runtime = makeReactDoctorRuntime(
      Promise.resolve({ exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") }),
    );
    const plugin = await getReactDoctorHooks(companion, repo, runtime);
    const event = plugin.event!;
    const after = plugin["tool.execute.after"]!;

    await event({ event: { type: "session.idle", properties: { sessionID: "one" } } } as never);
    await after(
      { tool: "edit", sessionID: "one", callID: "call", args: {} },
      { title: "", output: "", metadata: {} },
    );
    await event({ event: { type: "session.idle", properties: { sessionID: "two" } } } as never);
    await event({ event: { type: "session.idle", properties: { sessionID: "one" } } } as never);
    await event({ event: { type: "session.idle", properties: { sessionID: "one" } } } as never);

    expect(runtime.shellCalls).toHaveLength(1);
    expect(runtime.shellCalls[0]?.expressions.flat()).toEqual(
      expect.arrayContaining([
        "--yes",
        "--scope",
        "changed",
        "--base",
        "HEAD",
        "--max-duration",
        "30",
      ]),
    );
    expect(runtime.promptAsync).not.toHaveBeenCalled();
  });

  test("automatically sends findings to the edited session", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-react-findings-");
    const runtime = makeReactDoctorRuntime(
      Promise.resolve({
        exitCode: 1,
        stdout: Buffer.from("src/App.tsx:1 warning"),
        stderr: Buffer.from(""),
      }),
    );
    const plugin = await getReactDoctorHooks(companion, repo, runtime);

    await plugin["tool.execute.after"]!(
      { tool: "apply_patch", sessionID: "session-a", callID: "call", args: {} },
      { title: "", output: "", metadata: {} },
    );
    await plugin.event!({
      event: { type: "session.idle", properties: { sessionID: "session-a" } },
    } as never);

    expect(runtime.showToast).toHaveBeenCalledTimes(1);
    expect(runtime.promptAsync).toHaveBeenCalledWith({
      path: { id: "session-a" },
      query: { directory: repo },
      body: {
        parts: [
          {
            type: "text",
            synthetic: true,
            text: expect.stringContaining("src/App.tsx:1 warning"),
          },
        ],
      },
    });

    await plugin.event!({
      event: { type: "session.idle", properties: { sessionID: "session-a" } },
    } as never);
    expect(runtime.shellCalls).toHaveLength(1);
  });

  test("suppresses non-lint failures and command errors", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-react-errors-");
    const nonLint = makeReactDoctorRuntime(
      Promise.resolve({
        exitCode: 1,
        stdout: Buffer.from("No React dependency found"),
        stderr: Buffer.from(""),
      }),
    );
    const nonLintPlugin = await getReactDoctorHooks(companion, repo, nonLint);
    await nonLintPlugin["tool.execute.after"]!(
      { tool: "edit", sessionID: "one", callID: "1", args: {} },
      { title: "", output: "", metadata: {} },
    );
    await nonLintPlugin.event!({
      event: { type: "session.idle", properties: { sessionID: "one" } },
    } as never);
    expect(nonLint.promptAsync).not.toHaveBeenCalled();

    const failed = makeReactDoctorRuntime(Promise.reject(new Error("spawn failed")));
    const failedPlugin = await getReactDoctorHooks(companion, repo, failed);
    await failedPlugin["tool.execute.after"]!(
      { tool: "write", sessionID: "two", callID: "2", args: {} },
      { title: "", output: "", metadata: {} },
    );
    await expect(
      failedPlugin.event!({
        event: { type: "session.idle", properties: { sessionID: "two" } },
      } as never),
    ).resolves.toBeUndefined();
    expect(failed.promptAsync).not.toHaveBeenCalled();
  });

  test("deduplicates overlapping idle events per session without blocking another session", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-react-concurrent-");
    let resolveScan!: (result: { exitCode: number; stdout: Buffer; stderr: Buffer }) => void;
    const scan = new Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>((resolve) => {
      resolveScan = resolve;
    });
    const runtime = makeReactDoctorRuntime(scan);
    const plugin = await getReactDoctorHooks(companion, repo, runtime);
    const after = plugin["tool.execute.after"]!;
    const event = plugin.event!;
    const output = { title: "", output: "", metadata: {} };

    await after({ tool: "write", sessionID: "one", callID: "1", args: {} }, output);
    await after({ tool: "write", sessionID: "two", callID: "2", args: {} }, output);
    const first = event({
      event: { type: "session.idle", properties: { sessionID: "one" } },
    } as never);
    await event({
      event: { type: "session.idle", properties: { sessionID: "one" } },
    } as never);
    const second = event({
      event: { type: "session.idle", properties: { sessionID: "two" } },
    } as never);

    expect(runtime.shellCalls).toHaveLength(2);
    resolveScan({ exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") });
    await Promise.all([first, second]);
  });
});
