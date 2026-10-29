import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { guardToolInput } from "../opencode/companion-hooks";
import { readContext } from "../opencode/companion-policy";
import { COMPANION_SYNC_COMMAND } from "../runtime/companion-sync";
import { mateVersion } from "../runtime/install";
import { computeProjectionStamp, writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { trustProjection } from "../../test/trusted-projection";
import type { HookEnv } from "./hook-io";
import { evaluate, type HookOutcome } from "./validate-artifact-path";

const tempRoots: string[] = [];
const REGISTRY_CONTENT = "companions: []\n";
const ARTIFACT = "openspec/changes/acme/proposal.md";
let originalHome: string | undefined;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

interface Fixture {
  root: string;
  home: string;
  repo: string;
  companion: string;
  upstream: string;
}

function makeFixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-fork-guard-")));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const repo = path.join(root, "acme");
  const remote = path.join(root, "remote.git");
  const companion = path.join(root, "acme-companion");
  const upstream = path.join(root, "upstream");
  fs.mkdirSync(home);

  git(root, "init", "-q", "--initial-branch=main", repo);
  git(repo, "config", "user.email", "mate-tests@example.com");
  git(repo, "config", "user.name", "Mate Tests");
  fs.writeFileSync(path.join(repo, "README.md"), "acme\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");

  git(root, "init", "--bare", "-q", "--initial-branch=main", remote);
  fs.mkdirSync(companion);
  git(companion, "init", "-q", "--initial-branch=main");
  git(companion, "config", "user.email", "mate-tests@example.com");
  git(companion, "config", "user.name", "Mate Tests");
  fs.mkdirSync(path.join(companion, "openspec", "changes", "acme"), { recursive: true });
  fs.mkdirSync(path.join(companion, ".mate", "config"), { recursive: true });
  fs.writeFileSync(path.join(companion, ".mate", "config", "framework.yaml"), "git: auto\n");
  fs.writeFileSync(path.join(companion, "notes.md"), "base\n");
  git(companion, "add", ".");
  git(companion, "commit", "-qm", "base");
  git(companion, "remote", "add", "origin", remote);
  git(companion, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", remote, upstream);
  git(upstream, "config", "user.email", "mate-tests@example.com");
  git(upstream, "config", "user.name", "Mate Tests");

  const registryPath = repoLocalRegistryPath(repo);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, REGISTRY_CONTENT, "utf8");
  writeProjectionPair(repo, {
    stamp: computeProjectionStamp({
      version: mateVersion(),
      registryContent: REGISTRY_CONTENT,
    }),
    projection: {
      version: "0.0.0",
      companionPath: companion,
      repositoryPath: repo,
      repositoryId: "acme",
      wrapperBinPath: path.join(companion, "wrappers", "bin"),
      reactDoctorBinPath: path.join(companion, "react-doctor"),
      graphifyOut: path.join(companion, ".graphify", "acme", "graphify-out"),
    },
  });
  trustProjection({ home, companionPath: companion, repoRoot: repo, repositoryId: "acme" });

  return { root, home, repo, companion, upstream };
}

function forkHistory(fixture: Fixture): void {
  behindOnly(fixture);
  aheadOnly(fixture);
}

function aheadOnly(fixture: Fixture): void {
  fs.appendFileSync(path.join(fixture.companion, "local.md"), "local\n");
  git(fixture.companion, "add", ".");
  git(fixture.companion, "commit", "-qm", "local");
}

function behindOnly(fixture: Fixture): void {
  fs.appendFileSync(path.join(fixture.upstream, "notes.md"), "remote\n");
  git(fixture.upstream, "commit", "-aqm", "remote");
  git(fixture.upstream, "push", "-q", "origin", "main");
  git(fixture.companion, "fetch", "-q", "origin", "main");
}

/** No `MATE_*` variable: the guard resolves the companion from the Projection Root. */
function unmanagedEnv(fixture: Fixture): HookEnv {
  return { HOME: fixture.home };
}

function managedEnv(fixture: Fixture): HookEnv {
  return {
    HOME: fixture.home,
    MATE_ARTIFACT_PATH: fixture.companion,
    MATE_REPO_PATH: fixture.repo,
  };
}

async function writeVerdict(fixture: Fixture, target: string, env: HookEnv): Promise<HookOutcome> {
  return await evaluate(
    { tool_name: "Write", tool_input: { file_path: target } },
    env,
    fixture.repo,
  );
}

beforeEach(() => {
  originalHome = process.env.HOME;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("the Claude guard and a forked companion", () => {
  test("denies an artifact write, naming the fork and the recovery command", async () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    const outcome = await writeVerdict(
      fixture,
      path.join(fixture.companion, ARTIFACT),
      unmanagedEnv(fixture),
    );

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("forked");
    expect(outcome.stderr).toContain(COMPANION_SYNC_COMMAND);
  });
});

/** Each runtime's refusal of the same write, as text; empty when it allows the write. */
async function bothVerdicts(fixture: Fixture, target: string, env: HookEnv) {
  const claude = (await writeVerdict(fixture, target, env)).stderr;
  const openCode = await guardToolInput(
    readContext(env, fixture.repo),
    "write",
    { filePath: target },
    env,
  ).then(
    () => "",
    (error: Error) => `${error.message}\n`,
  );
  return { claude, openCode };
}

describe("both runtimes return the same verdict on a forked companion", () => {
  for (const [name, prepare, refused] of [
    ["forked", forkHistory, true],
    ["ahead only", aheadOnly, false],
    ["behind only", behindOnly, false],
  ] as const) {
    test(name, async () => {
      const fixture = makeFixture();
      prepare(fixture);
      process.env.HOME = fixture.home;

      const { claude, openCode } = await bothVerdicts(
        fixture,
        path.join(fixture.companion, ARTIFACT),
        unmanagedEnv(fixture),
      );

      expect(openCode).toBe(claude);
      expect(claude !== "").toBe(refused);
    });
  }

  test("both permit a managed session with a forked history", async () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    const verdicts = await bothVerdicts(
      fixture,
      path.join(fixture.companion, ARTIFACT),
      managedEnv(fixture),
    );
    expect(verdicts).toEqual({ claude: "", openCode: "" });
  });

  test("both permit a non-artifact write while the history has forked", async () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    const verdicts = await bothVerdicts(
      fixture,
      path.join(fixture.companion, "src", "index.ts"),
      unmanagedEnv(fixture),
    );
    expect(verdicts).toEqual({ claude: "", openCode: "" });
  });

  test("both refuse an upper-case Markdown write while the history has forked", async () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    const { claude, openCode } = await bothVerdicts(
      fixture,
      path.join(fixture.companion, "NOTES.MD"),
      unmanagedEnv(fixture),
    );
    expect(claude).toContain("forked");
    expect(openCode).toBe(claude);
  });

  test("OpenCode refuses moving a companion file out while the history has forked", async () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;
    const env = unmanagedEnv(fixture);

    const refusal = await guardToolInput(
      readContext(env, fixture.repo),
      "apply_patch",
      {
        patchText: [
          "*** Begin Patch",
          `*** Update File: ${path.join(fixture.companion, "notes.md")}`,
          `*** Move to: ${path.join(fixture.repo, "src", "notes.ts")}`,
          "@@",
          "-base",
          "+base",
          "*** End Patch",
        ].join("\n"),
      },
      env,
    ).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(refusal).toContain("forked");
    expect(refusal).toContain(COMPANION_SYNC_COMMAND);
  });

  test("both fall through when the check cannot complete", async () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    git(fixture.companion, "update-ref", "-d", "refs/remotes/origin/main");
    git(fixture.companion, "branch", "--unset-upstream");
    git(fixture.companion, "remote", "remove", "origin");
    process.env.HOME = fixture.home;

    const verdicts = await bothVerdicts(
      fixture,
      path.join(fixture.companion, ARTIFACT),
      unmanagedEnv(fixture),
    );
    expect(verdicts).toEqual({ claude: "", openCode: "" });
  });
});
