import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { createTempDir, withEnv } from "../../../../test/fixtures";
import {
  guardToolInput,
  registerCompanionHooks,
  registerTokensaveRouting,
} from "./companion-hooks";
import { readContext, type CompanionContext } from "./companion-policy";
import { ARTIFACT_REFUSAL_HEADLINE } from "../runtime/artifact-refusal";
import { MATE_ENV } from "../runtime/env-names";
import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { ROUTE_SYNC_MARKER, TOKENSAVE_DB } from "../runtime/tokensave-route";
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
    ).rejects.toThrow(ARTIFACT_REFUSAL_HEADLINE);
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

  test("names the resolution of a relative apply_patch path", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-patch-relative-");
    const context = await launchContext(companion, repo);

    const refusal = await guardToolInput(context, "apply_patch", {
      patchText: "*** Add File: notes/x.md\ncontent",
    }).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(refusal).toContain(` resolved:  ${path.join(repo, "notes", "x.md")}`);
    expect(refusal).toContain(` suggested: ${path.join(companion, "notes", "x.md")}`);
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

describe("OpenCode commit-attribution guard", () => {
  test("refuses a bash commit with a model co-author trailer, after the secret check", async () => {
    const { repo, companion } = await setupRepoFixture("mate-opencode-attribution-");
    const context = await launchContext(companion, repo);
    const trailer = "Co-Authored-By: Claude <noreply@anthropic.com>";

    await expect(
      guardToolInput(context, "bash", { command: `git commit -m "x" -m "${trailer}"` }),
    ).rejects.toThrow("No commit was created");
    await expect(
      guardToolInput(context, "bash", { command: `git commit -m "${trailer}" && cat .env` }),
    ).rejects.toThrow("secret files are off-limits");
    await expect(
      guardToolInput(context, "bash", {
        command: `git commit -m "Co-Authored-By: Jane <jane@acme.example>"`,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("OpenCode secret guardrails", () => {
  const GITHUB_TOKEN = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");

  async function guarded() {
    const { repo, companion } = await setupRepoFixture("mate-opencode-secrets-");
    return { repo, companion, context: await launchContext(companion, repo) };
  }

  test("refuses read and edit of secret files, and lets the example through", async () => {
    const { repo, context } = await guarded();
    await expect(
      guardToolInput(context, "read", { filePath: path.join(repo, ".env") }),
    ).rejects.toThrow("secret files are off-limits");
    await expect(
      guardToolInput(context, "edit", { filePath: "certs/server.key", newString: "x" }),
    ).rejects.toThrow("certs/server.key");
    await expect(
      guardToolInput(context, "read", { filePath: path.join(repo, ".env.example") }),
    ).resolves.toBeUndefined();
  });

  test("refuses a differently-cased secret file", async () => {
    const { repo, context } = await guarded();
    await expect(
      guardToolInput(context, "read", { filePath: path.join(repo, ".Env") }),
    ).rejects.toThrow("secret files are off-limits");
  });

  test("refuses bash commands naming a secret file", async () => {
    const { context } = await guarded();
    await expect(guardToolInput(context, "bash", { command: "source .env" })).rejects.toThrow(
      "secret files are off-limits",
    );
    await expect(
      guardToolInput(context, "bash", { command: "cat .env.example" }),
    ).resolves.toBeUndefined();
  });

  test("refuses a grep in a secret file or aimed at secret files", async () => {
    const { repo, context } = await guarded();
    await expect(
      guardToolInput(context, "grep", { pattern: "KEY", path: path.join(repo, ".env") }),
    ).rejects.toThrow("secret files are off-limits");
    await expect(
      guardToolInput(context, "grep", { pattern: "KEY", path: repo, include: "*.pem" }),
    ).rejects.toThrow("*.pem");
    await expect(
      guardToolInput(context, "grep", { pattern: "KEY", path: repo, include: "*.ts" }),
    ).resolves.toBeUndefined();
  });

  test("refuses a patch that adds a secret file", async () => {
    const { context } = await guarded();
    await expect(
      guardToolInput(context, "apply_patch", { patchText: "*** Add File: .env.local\n+KEY=1" }),
    ).rejects.toThrow(".env.local");
  });

  test("scans companion writes and patches, never echoing the value", async () => {
    const { companion, context } = await guarded();
    const target = path.join(companion, "notes", "design.md");
    const write = guardToolInput(context, "write", {
      filePath: target,
      content: `token: ${GITHUB_TOKEN}\n`,
    });
    await expect(write).rejects.toThrow("@secretlint/secretlint-rule-github");
    await write.catch((error: Error) => expect(error.message).not.toContain(GITHUB_TOKEN));

    await expect(
      guardToolInput(context, "apply_patch", {
        patchText: `*** Update File: ${target}\n@@\n-old\n+token: ${GITHUB_TOKEN}`,
      }),
    ).rejects.toThrow("@secretlint/secretlint-rule-github");
  });

  test("does not scan product code writes", async () => {
    const { repo, context } = await guarded();
    await expect(
      guardToolInput(context, "write", {
        filePath: path.join(repo, "src", "main.ts"),
        content: GITHUB_TOKEN,
      }),
    ).resolves.toBeUndefined();
  });

  async function guardedPolicy(config: string) {
    const guard = await guarded();
    const configPath = path.join(guard.companion, ".mate", "config", "framework.yaml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, config, "utf8");
    return { ...guard, configPath };
  }

  test("refuses an edit that turns guardrails off", async () => {
    const { context, configPath } = await guardedPolicy(
      "git: manual\nsecrets:\n  guardrails: true\n",
    );
    await expect(
      guardToolInput(context, "edit", {
        path: configPath,
        oldString: "guardrails: true",
        newString: "guardrails: false",
      }),
    ).rejects.toThrow("change: guardrails turned off");
  });

  test("refuses a patch that touches the policy file", async () => {
    const { context, configPath } = await guardedPolicy("git: manual\n");
    await expect(
      guardToolInput(context, "patch", {
        patchText: `*** Update File: ${configPath}\n@@\n-git: manual\n+git: auto`,
      }),
    ).rejects.toThrow("change: the result could not be checked");
  });

  test("refuses an edit and a patch that reach the policy file through ~/", async () => {
    const { context, configPath } = await guardedPolicy(
      "git: manual\nsecrets:\n  guardrails: true\n",
    );
    const viaHome = `~/${path.relative(os.homedir(), configPath)}`;
    await expect(
      guardToolInput(context, "edit", {
        path: viaHome,
        oldString: "guardrails: true",
        newString: "guardrails: false",
      }),
    ).rejects.toThrow("change: guardrails turned off");
    await expect(
      guardToolInput(context, "patch", {
        patchText: `*** Update File: ${viaHome}\n@@\n-git: manual\n+git: auto`,
      }),
    ).rejects.toThrow("change: the result could not be checked");
  });

  test("refuses a patch that moves another file onto the policy file", async () => {
    const { context, configPath } = await guardedPolicy("git: manual\n");
    const source = path.join(path.dirname(configPath), "acme.yaml");
    await expect(
      guardToolInput(context, "patch", {
        patchText: `*** Update File: ${source}\n*** Move to: ${configPath}\n@@\n-a\n+b`,
      }),
    ).rejects.toThrow("change: the result could not be checked");
  });
});

describe("OpenCode tokensave routing", () => {
  async function routedFixture() {
    const { repo, companion } = await setupRepoFixture("mate-opencode-route-");
    const identity = ["-c", "user.name=acme", "-c", "user.email=acme@example.com"];
    spawnSync("git", [...identity, "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
    const worktree = path.join(path.dirname(repo), "repo.worktrees", "fix");
    spawnSync("git", ["worktree", "add", "-q", "-b", "fix", worktree], { cwd: repo });
    await fs.mkdir(path.join(worktree, ".tokensave"), { recursive: true });
    await fs.writeFile(path.join(worktree, TOKENSAVE_DB), "");
    // A fresh marker: routing skips its `tokensave sync`.
    await fs.writeFile(path.join(worktree, ROUTE_SYNC_MARKER), "");
    const context = await launchContext(companion, repo);
    return { repo, worktree: await fs.realpath(worktree), context };
  }

  /** A session whose directory `move` changes, as `api.session.move` does. */
  function sessionApi(start: string) {
    const location = { directory: start };
    const { api, hooks } = fakeApi(start) as unknown as {
      api: { session: Record<string, unknown> };
      hooks: Map<string, Hook>;
    };
    api.session.get = async () => ({ location });
    return {
      api: api as never,
      hooks,
      move: (directory: string) => (location.directory = directory),
    };
  }

  function search(input: Record<string, unknown>, tool = "tokensave_tokensave_search") {
    return { tool, sessionID: "s", input };
  }

  test("routes a nested tokensave call and leaves execute and other tools alone", async () => {
    const { repo, worktree } = await routedFixture();
    const { api, hooks, move } = sessionApi(repo);
    move(worktree);
    await registerTokensaveRouting(api);
    const before = hooks.get("tool.execute.before")!;

    const nested = search({ query: "alpha" });
    await before(nested);
    expect(nested.input).toEqual({ query: "alpha", graph_root: worktree });

    const wrapper = search({ code: "tools.tokensave" }, "execute");
    const other = search({ query: "alpha" }, "acme_search");
    await before(wrapper);
    await before(other);
    expect(wrapper.input).toEqual({ code: "tools.tokensave" });
    expect(other.input).toEqual({ query: "alpha" });
  });

  test("a session moved into the worktree is routed to it; the main checkout is not", async () => {
    const { repo, worktree } = await routedFixture();
    const { api, hooks, move } = sessionApi(repo);
    await registerTokensaveRouting(api);
    const before = hooks.get("tool.execute.before")!;

    const fromMain = search({ query: "alpha" });
    await before(fromMain);
    expect(fromMain.input).toEqual({ query: "alpha" });

    move(worktree);
    const moved = search({ task: "alpha" }, "tokensave_tokensave_context");
    await before(moved);
    expect(moved.input).toEqual({ task: "alpha", graph_root: worktree });
  });

  test("a plugin started in the indexed worktree leaves its calls unchanged", async () => {
    const { worktree } = await routedFixture();
    const { api, hooks } = sessionApi(worktree);
    await registerTokensaveRouting(api);

    const call = search({ query: "alpha" });
    await hooks.get("tool.execute.before")!(call);
    expect(call.input).toEqual({ query: "alpha" });
  });

  test("an explicit graph_root and a failing session lookup pass unchanged", async () => {
    const { repo, worktree } = await routedFixture();
    const explicit = sessionApi(worktree);
    await registerTokensaveRouting(explicit.api);
    const call = search({ graph_root: "/src/other" });
    await explicit.hooks.get("tool.execute.before")!(call);
    expect(call.input).toEqual({ graph_root: "/src/other" });

    /** No `session.get`: the lookup throws and the start directory, the main checkout, decides. */
    const { api, hooks } = fakeApi(repo);
    await registerTokensaveRouting(api);
    const fallback = search({ query: "alpha" });
    await hooks.get("tool.execute.before")!(fallback);
    expect(fallback.input).toEqual({ query: "alpha" });
  });
});
