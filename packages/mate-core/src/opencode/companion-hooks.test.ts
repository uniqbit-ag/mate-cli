import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { createTempDir, withEnv } from "../../../../test/fixtures";
import { guardToolInput, registerCompanionHooks } from "./companion-hooks";
import { readContext, type CompanionContext } from "./companion-policy";
import { MATE_ENV } from "../runtime/env-names";
import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  tempRoots.push(dir);
  return dir;
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
  for (const enabled of ["1", "0"]) {
    test(`registers only the guard (MATE_REACT_DOCTOR_ENABLED=${enabled})`, async () => {
      const { repo, companion } = await setupRepoFixture("mate-opencode-register-");
      const context = await launchContext(companion, repo, { MATE_REACT_DOCTOR_ENABLED: enabled });
      const { api, hooks } = fakeApi(repo);

      expect(await registerCompanionHooks(api, context)).toBeUndefined();
      expect([...hooks.keys()]).toEqual(["tool.execute.before"]);
    });
  }

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
