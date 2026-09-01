import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { refuseForkedCompanionWrite } from "../opencode/companion-hooks";
import { readContext } from "../opencode/companion-policy";
import { COMPANION_SYNC_COMMAND } from "../runtime/companion-sync";
import { mateVersion } from "../runtime/install";
import { computeProjectionStamp, writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { evaluate, type HookEnv, type HookOutcome } from "./validate-artifact-path";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-fork-guard-"));
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

function writeVerdict(fixture: Fixture, target: string, env: HookEnv): HookOutcome {
  return evaluate({ tool_name: "Write", tool_input: { file_path: target } }, env, fixture.repo);
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
  test("denies an artifact write, naming the fork and the recovery command", () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    const outcome = writeVerdict(
      fixture,
      path.join(fixture.companion, ARTIFACT),
      unmanagedEnv(fixture),
    );

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("forked");
    expect(outcome.stderr).toContain(COMPANION_SYNC_COMMAND);
  });

  test("allows the write when the companion is only ahead", () => {
    const fixture = makeFixture();
    aheadOnly(fixture);
    process.env.HOME = fixture.home;

    expect(
      writeVerdict(fixture, path.join(fixture.companion, ARTIFACT), unmanagedEnv(fixture)).exitCode,
    ).toBe(0);
  });

  test("allows the write when the companion is only behind", () => {
    const fixture = makeFixture();
    behindOnly(fixture);
    process.env.HOME = fixture.home;

    expect(
      writeVerdict(fixture, path.join(fixture.companion, ARTIFACT), unmanagedEnv(fixture)).exitCode,
    ).toBe(0);
  });

  test("allows a non-artifact write while the history has forked", () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    expect(
      writeVerdict(fixture, path.join(fixture.companion, "src", "index.ts"), unmanagedEnv(fixture))
        .exitCode,
    ).toBe(0);
  });

  test("allows the write in a managed session, so a launch's Git decision stands", () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    expect(
      writeVerdict(fixture, path.join(fixture.companion, ARTIFACT), managedEnv(fixture)).exitCode,
    ).toBe(0);
  });

  test("keeps the working-repository path refusal's message when both reasons apply", () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    const outcome = writeVerdict(fixture, path.join(fixture.repo, ARTIFACT), unmanagedEnv(fixture));

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("artifact writes must go to the companion framework path");
    expect(outcome.stderr).not.toContain("forked");
  });

  test("falls through to its existing verdict when no upstream ref is present locally", () => {
    const fixture = makeFixture();
    aheadOnly(fixture);
    git(fixture.companion, "branch", "--unset-upstream");
    git(fixture.companion, "remote", "remove", "origin");
    git(fixture.companion, "update-ref", "-d", "refs/remotes/origin/main");
    process.env.HOME = fixture.home;

    expect(
      writeVerdict(fixture, path.join(fixture.companion, ARTIFACT), unmanagedEnv(fixture)).exitCode,
    ).toBe(0);
  });

  test("refuses a Bash redirect into the companion while the history has forked", () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    const outcome = evaluate(
      {
        tool_name: "Bash",
        tool_input: { command: `echo hi > ${path.join(fixture.companion, ARTIFACT)}` },
      },
      unmanagedEnv(fixture),
      fixture.repo,
    );

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("forked");
  });

  test("computes the verdict at most once per interval rather than per write", () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;
    const target = path.join(fixture.companion, ARTIFACT);

    expect(writeVerdict(fixture, target, unmanagedEnv(fixture)).exitCode).toBe(2);

    // Repaired on disk, but the cached verdict still answers until the
    // interval elapses — which is what keeps repeated writes off Git.
    git(fixture.companion, "reset", "-q", "--hard", "origin/main");
    expect(writeVerdict(fixture, target, unmanagedEnv(fixture)).exitCode).toBe(2);
  });
});

describe("both runtimes return the same verdict", () => {
  for (const [name, prepare] of [
    ["forked", forkHistory],
    ["ahead only", aheadOnly],
    ["behind only", behindOnly],
  ] as const) {
    test(`${name}`, () => {
      const fixture = makeFixture();
      prepare(fixture);
      process.env.HOME = fixture.home;
      const target = path.join(fixture.companion, ARTIFACT);

      const claudeRefused = writeVerdict(fixture, target, unmanagedEnv(fixture)).exitCode === 2;

      let openCodeRefused = false;
      try {
        refuseForkedCompanionWrite(
          readContext(unmanagedEnv(fixture), fixture.repo),
          target,
          unmanagedEnv(fixture),
        );
      } catch {
        openCodeRefused = true;
      }

      expect(openCodeRefused).toBe(claudeRefused);
    });
  }

  test("the middleware permits a managed session with a forked history", () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    expect(() =>
      refuseForkedCompanionWrite(
        readContext(managedEnv(fixture), fixture.repo),
        path.join(fixture.companion, ARTIFACT),
        managedEnv(fixture),
      ),
    ).not.toThrow();
  });

  test("the middleware permits a non-artifact write while the history has forked", () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    expect(() =>
      refuseForkedCompanionWrite(
        readContext(unmanagedEnv(fixture), fixture.repo),
        path.join(fixture.companion, "src", "index.ts"),
        unmanagedEnv(fixture),
      ),
    ).not.toThrow();
  });

  test("the middleware falls through when the check cannot complete", () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    git(fixture.companion, "update-ref", "-d", "refs/remotes/origin/main");
    git(fixture.companion, "branch", "--unset-upstream");
    git(fixture.companion, "remote", "remove", "origin");
    process.env.HOME = fixture.home;

    expect(() =>
      refuseForkedCompanionWrite(
        readContext(unmanagedEnv(fixture), fixture.repo),
        path.join(fixture.companion, ARTIFACT),
        unmanagedEnv(fixture),
      ),
    ).not.toThrow();
  });
});
