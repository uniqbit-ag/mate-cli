import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  createReactDoctorScanner,
  guardToolInput,
  registerCompanionHooks,
  type CommandResult,
} from "./companion-hooks";
import { readContext, type CompanionContext } from "./companion-policy";
import { MATE_ENV } from "../runtime/env-names";
import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
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

type Hook = (event: Record<string, unknown>) => unknown;

/** Records registered hooks; the event stream never yields. */
function fakeApi(directory: string) {
  const hooks = new Map<string, Hook>();
  const register =
    (domain: string) =>
    async (name: string, callback: Hook): Promise<void> => {
      hooks.set(`${domain}.${name}`, callback);
    };
  const api = {
    location: { directory },
    tool: { hook: register("tool") },
    session: { prompt: mock(async () => undefined) },
    event: {
      subscribe: async function* () {
        await new Promise(() => {});
      },
    },
  };
  return { api: api as never, hooks };
}

function launchContext(
  companion: string,
  repo: string | undefined,
  extra: Record<string, string> = {},
): Promise<CompanionContext> {
  return withEnv(
    {
      ...noLaunchEnvironment(),
      MATE_ARTIFACT_PATH: companion,
      MATE_REPO_PATH: repo,
      MATE_REPO_ID: repo ? "acme" : undefined,
      MATE_POLICY_JSON: "{}",
      MATE_GIT_AUTO_MODE: "0",
      ...extra,
    },
    async () => readContext(process.env, repo ?? companion),
  );
}

async function setupRepoFixture(prefix: string) {
  const root = await makeTempDir(prefix);
  const repo = path.join(root, "repo");
  const companion = path.join(root, "companion");
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(companion, { recursive: true });
  spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  return { repo, companion };
}

function scanResult(exitCode: number, output = ""): Promise<CommandResult> {
  return Promise.resolve({ exitCode, output });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("OpenCode companion hooks without a launch", () => {
  test("activates from a projection and blocks an artifact write", async () => {
    const repo = await makeTempDir("mate-hooks-wrapped-");
    const companion = path.join(repo, "companion");
    await fs.mkdir(companion, { recursive: true });
    await wrapRepo(repo, companion);

    const context = readContext(noLaunchEnvironment(), repo);
    expect(context.companionPath).toBe(companion);
    await expect(
      guardToolInput(context, "write", { filePath: path.join(repo, "design.md") }),
    ).rejects.toThrow("artifact writes must go to the companion framework path");
  });

  test("resolves no companion when neither the environment nor a projection does", async () => {
    const repo = await makeTempDir("mate-hooks-unwrapped-");

    expect(readContext(noLaunchEnvironment(), repo).companionPath).toBe("");
  });

  test("registers only the guard without a working repository", async () => {
    const companion = await makeTempDir("mate-hooks-companion-only-");
    const context = await launchContext(companion, undefined, { MATE_REACT_DOCTOR_ENABLED: "1" });
    const { api, hooks } = fakeApi(companion);

    expect(await registerCompanionHooks(api, context)).toBeUndefined();
    expect([...hooks.keys()]).toEqual(["tool.execute.before"]);
  });
});

describe("OpenCode companion hooks", () => {
  test("registers the guard, the edit tracker, and a cleanup with React Doctor enabled", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-register-");
    const context = await launchContext(companion, repo, { MATE_REACT_DOCTOR_ENABLED: "1" });
    const { api, hooks } = fakeApi(repo);

    const cleanup = await registerCompanionHooks(api, context);

    expect([...hooks.keys()].sort()).toEqual(["tool.execute.after", "tool.execute.before"]);
    expect(cleanup).toBeFunction();
    cleanup?.();
  });

  test("registers no edit tracker with React Doctor disabled", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-register-off-");
    const context = await launchContext(companion, repo);
    const { api, hooks } = fakeApi(repo);

    expect(await registerCompanionHooks(api, context)).toBeUndefined();
    expect([...hooks.keys()]).toEqual(["tool.execute.before"]);
  });

  test("the registered guard rejects an artifact write", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-before-hook-");
    const context = await launchContext(companion, repo);
    const { api, hooks } = fakeApi(repo);
    await registerCompanionHooks(api, context);

    await expect(
      hooks.get("tool.execute.before")!({
        tool: "write",
        sessionID: "s",
        input: { filePath: path.join(repo, "spec.md") },
      }),
    ).rejects.toThrow("guardrail");
  });

  test("blocks artifact writes and allows source writes", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-before-");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "write", { filePath: path.join(repo, "spec.md") }),
    ).rejects.toThrow("guardrail");
    await expect(
      guardToolInput(context, "write", { filePath: path.join(repo, "src", "main.ts") }),
    ).resolves.toBeUndefined();
  });

  test("blocks artifact paths in apply_patch", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-patch-");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "apply_patch", { patchText: "*** Add File: spec.md\ncontent" }),
    ).rejects.toThrow("guardrail");
    await expect(
      guardToolInput(context, "apply_patch", { patchText: "*** Add File: src/main.ts\ncontent" }),
    ).resolves.toBeUndefined();
  });

  test("allows gitignored artifact writes", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-gitignore-");
    await fs.writeFile(path.join(repo, ".gitignore"), "local-notes.md\n", "utf8");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "write", { filePath: path.join(repo, "local-notes.md") }),
    ).resolves.toBeUndefined();
  });

  test("ignores tools that write nothing", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-read-");
    const context = await launchContext(companion, repo);

    await expect(
      guardToolInput(context, "read", { filePath: path.join(repo, "spec.md") }),
    ).resolves.toBeUndefined();
    await expect(guardToolInput(context, "bash", undefined)).resolves.toBeUndefined();
  });
});

describe("React Doctor scanner", () => {
  async function scanner(prefix: string, result: () => Promise<CommandResult>) {
    const { repo, companion } = await setupRepoFixture(prefix);
    const context = await launchContext(companion, repo, { MATE_REACT_DOCTOR_ENABLED: "1" });
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const session = { prompt: mock(async (_input: unknown) => undefined) };
    const run = async (command: string, args: string[], cwd: string) => {
      calls.push({ command, args, cwd });
      return result();
    };
    return { repo, calls, session, scan: createReactDoctorScanner(context, session as never, run) };
  }

  test("uses the Mate-owned React Doctor executable when no repo binary exists", async () => {
    const mateBin = path.join(await makeTempDir("mate-opencode-react-doctor-bin-"), "react-doctor");
    await fs.writeFile(mateBin, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(mateBin, 0o755);
    const { calls, scan } = await scanner("mate-opencode-react-doctor-runtime-", () =>
      scanResult(0),
    );

    await withEnv({ MATE_REACT_DOCTOR_BIN_PATH: mateBin }, async () => {
      scan.markEdited("edit", "one");
      await scan.idle("one");
    });

    expect(calls[0]?.command).toBe(mateBin);
  });

  test("runs one bounded scan only after an edit", async () => {
    const { repo, calls, session, scan } = await scanner("mate-opencode-react-doctor-", () =>
      scanResult(0),
    );

    await scan.idle("one");
    scan.markEdited("read", "one");
    await scan.idle("one");
    scan.markEdited("edit", "one");
    await scan.idle("two");
    await scan.idle("one");
    await scan.idle("one");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(repo);
    expect(calls[0]?.args).toEqual(
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
    expect(session.prompt).not.toHaveBeenCalled();
  });

  test("sends findings to the edited session", async () => {
    const { calls, session, scan } = await scanner("mate-opencode-react-findings-", () =>
      scanResult(1, "src/App.tsx:1 warning"),
    );

    scan.markEdited("apply_patch", "session-a");
    await scan.idle("session-a");

    expect(session.prompt).toHaveBeenCalledWith({
      sessionID: "session-a",
      text: expect.stringContaining("src/App.tsx:1 warning"),
    });

    await scan.idle("session-a");
    expect(calls).toHaveLength(1);
  });

  test("suppresses non-lint failures and command errors", async () => {
    const nonLint = await scanner("mate-opencode-react-nonlint-", () =>
      scanResult(1, "No React dependency found"),
    );
    nonLint.scan.markEdited("edit", "one");
    await nonLint.scan.idle("one");
    expect(nonLint.session.prompt).not.toHaveBeenCalled();

    const failed = await scanner("mate-opencode-react-errors-", () =>
      Promise.reject(new Error("spawn failed")),
    );
    failed.scan.markEdited("write", "two");
    await expect(failed.scan.idle("two")).resolves.toBeUndefined();
    expect(failed.session.prompt).not.toHaveBeenCalled();
  });

  test("deduplicates overlapping idle events per session without blocking another session", async () => {
    let resolveScan!: (result: CommandResult) => void;
    const pending = new Promise<CommandResult>((resolve) => {
      resolveScan = resolve;
    });
    const { calls, scan } = await scanner("mate-opencode-react-concurrent-", () => pending);

    scan.markEdited("write", "one");
    scan.markEdited("write", "two");
    const first = scan.idle("one");
    scan.markEdited("write", "one");
    await scan.idle("one");
    const second = scan.idle("two");

    expect(calls).toHaveLength(2);
    resolveScan({ exitCode: 0, output: "" });
    await Promise.all([first, second]);
  });
});
