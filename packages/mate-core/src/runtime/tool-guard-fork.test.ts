import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ARTIFACT_REFUSAL_HEADLINE } from "./artifact-refusal";
import { COMPANION_SYNC_COMMAND } from "./companion-sync";
import { mateVersion } from "./install";
import { computeProjectionStamp, writeProjectionPair } from "./projection";
import { repoLocalRegistryPath } from "./repo-local";
import { checkToolCall, type ToolGuardRefusal } from "./tool-guard";

type HookEnv = Record<string, string | undefined>;

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

function scopeFor(fixture: Fixture, env: HookEnv) {
  return {
    companionPath: fixture.companion,
    repositoryPath: fixture.repo,
    runtimeStateRoots: [],
    env,
  };
}

async function writeVerdict(
  fixture: Fixture,
  target: string,
  env: HookEnv,
): Promise<ToolGuardRefusal | null> {
  return await checkToolCall(
    { kind: "write", writes: [{ path: target, content: "", mode: "create" }] },
    scopeFor(fixture, env),
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

describe("the Tool Guard and a forked companion", () => {
  test("denies an artifact write, naming the fork and the recovery command", async () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    const outcome = await writeVerdict(
      fixture,
      path.join(fixture.companion, ARTIFACT),
      unmanagedEnv(fixture),
    );

    expect(outcome?.check).toBe("fork");
    expect(outcome?.message).toContain("forked");
    expect(outcome?.message).toContain(COMPANION_SYNC_COMMAND);
  });

  test("allows the write when the companion is only ahead", async () => {
    const fixture = makeFixture();
    aheadOnly(fixture);
    process.env.HOME = fixture.home;

    expect(
      await writeVerdict(fixture, path.join(fixture.companion, ARTIFACT), unmanagedEnv(fixture)),
    ).toBeNull();
  });

  test("allows the write when the companion is only behind", async () => {
    const fixture = makeFixture();
    behindOnly(fixture);
    process.env.HOME = fixture.home;

    expect(
      await writeVerdict(fixture, path.join(fixture.companion, ARTIFACT), unmanagedEnv(fixture)),
    ).toBeNull();
  });

  test("allows a non-artifact write while the history has forked", async () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    expect(
      await writeVerdict(
        fixture,
        path.join(fixture.companion, "src", "index.ts"),
        unmanagedEnv(fixture),
      ),
    ).toBeNull();
  });

  test("allows the write in a managed session, so a launch's Git decision stands", async () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    expect(
      await writeVerdict(fixture, path.join(fixture.companion, ARTIFACT), managedEnv(fixture)),
    ).toBeNull();
  });

  test("keeps the working-repository path refusal's message when both reasons apply", async () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    const outcome = await writeVerdict(
      fixture,
      path.join(fixture.repo, ARTIFACT),
      unmanagedEnv(fixture),
    );

    expect(outcome?.check).toBe("artifact");
    expect(outcome?.message).toContain(ARTIFACT_REFUSAL_HEADLINE);
    expect(outcome?.message).not.toContain("forked");
  });

  test("falls through to its existing verdict when no upstream ref is present locally", async () => {
    const fixture = makeFixture();
    aheadOnly(fixture);
    git(fixture.companion, "branch", "--unset-upstream");
    git(fixture.companion, "remote", "remove", "origin");
    git(fixture.companion, "update-ref", "-d", "refs/remotes/origin/main");
    process.env.HOME = fixture.home;

    expect(
      await writeVerdict(fixture, path.join(fixture.companion, ARTIFACT), unmanagedEnv(fixture)),
    ).toBeNull();
  });

  test("refuses a Bash redirect into the companion while the history has forked", async () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;

    const outcome = await checkToolCall(
      { kind: "shell", command: `echo hi > ${path.join(fixture.companion, ARTIFACT)}` },
      scopeFor(fixture, unmanagedEnv(fixture)),
    );

    expect(outcome?.check).toBe("fork");
  });

  test("computes the verdict at most once per interval rather than per write", async () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;
    const target = path.join(fixture.companion, ARTIFACT);

    expect((await writeVerdict(fixture, target, unmanagedEnv(fixture)))?.check).toBe("fork");

    // Repaired on disk, but the cached verdict still answers until the
    // interval elapses — which is what keeps repeated writes off Git.
    git(fixture.companion, "reset", "-q", "--hard", "origin/main");
    expect((await writeVerdict(fixture, target, unmanagedEnv(fixture)))?.check).toBe("fork");
  });

  test("judges the companion a `link/..` configured path lands in", async () => {
    const fixture = makeFixture();
    forkHistory(fixture);
    process.env.HOME = fixture.home;
    // `up` leads to `deep/x`, so `up/../..` is the fixture root; normalised, it is its parent.
    fs.mkdirSync(path.join(fixture.root, "deep", "x"), { recursive: true });
    fs.symlinkSync(path.join(fixture.root, "deep", "x"), path.join(fixture.root, "up"));
    const configured = `${path.join(fixture.root, "up")}/../../${path.basename(fixture.companion)}`;

    const outcome = await checkToolCall(
      {
        kind: "write",
        writes: [{ path: path.join(fixture.companion, ARTIFACT), content: "", mode: "create" }],
      },
      { ...scopeFor(fixture, unmanagedEnv(fixture)), companionPath: configured },
    );

    expect(outcome?.check).toBe("fork");
  });
});
