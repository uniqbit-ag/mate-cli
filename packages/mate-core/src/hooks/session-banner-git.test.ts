import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { COMPANION_SYNC_COMMAND } from "../runtime/companion-sync";
import { recordCompanionSync } from "../runtime/companion-git-state";
import { mateVersion } from "../runtime/install";
import { computeProjectionStamp, writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { buildSessionGuidance } from "./session-guidance";
import { buildBanner } from "./session-banner";

const tempRoots: string[] = [];
const REGISTRY_CONTENT = "companions: []\n";
/** Session start must not be held up; the assertions below use this as the ceiling. */
const TIME_BOUND_MS = 20_000;

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

function makeFixture(gitPolicy: "auto" | "manual" = "auto"): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-banner-git-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const repo = path.join(root, "acme");
  const remote = path.join(root, "remote.git");
  const companion = path.join(root, "acme-companion");
  const upstream = path.join(root, "upstream");
  fs.mkdirSync(home);
  fs.mkdirSync(repo, { recursive: true });

  git(root, "init", "--bare", "-q", "--initial-branch=main", remote);
  fs.mkdirSync(companion);
  git(companion, "init", "-q", "--initial-branch=main");
  git(companion, "config", "user.email", "mate-tests@example.com");
  git(companion, "config", "user.name", "Mate Tests");
  fs.mkdirSync(path.join(companion, ".mate", "config"), { recursive: true });
  fs.writeFileSync(
    path.join(companion, ".mate", "config", "framework.yaml"),
    `git: ${gitPolicy}\n`,
  );
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

function commitUpstream(fixture: Fixture, message: string): void {
  fs.appendFileSync(path.join(fixture.upstream, "notes.md"), `${message}\n`);
  git(fixture.upstream, "commit", "-aqm", message);
  git(fixture.upstream, "push", "-q", "origin", "main");
}

function commitCompanion(fixture: Fixture, message: string): void {
  fs.appendFileSync(path.join(fixture.companion, "local.md"), `${message}\n`);
  git(fixture.companion, "add", ".");
  git(fixture.companion, "commit", "-qm", message);
}

function bannerMessage(stdout: string): string {
  return (JSON.parse(stdout) as { systemMessage: string }).systemMessage;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SessionStart repairs the companion", () => {
  test("runs the unattended synchronization before emitting its banner", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");

    const outcome = buildBanner({}, fixture.repo, [], { homeDir: fixture.home });

    expect(outcome.exitCode).toBe(0);
    expect(git(fixture.companion, "log", "-1", "--pretty=%s")).toBe("remote");
    expect(bannerMessage(outcome.stdout)).toContain(fixture.companion);
  });

  test("performs no Git work when the synchronization is not due", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    recordCompanionSync(fixture.companion, new Date(), fixture.home);
    const before = git(fixture.companion, "rev-parse", "HEAD");

    buildBanner({}, fixture.repo, [], { homeDir: fixture.home });

    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
  });

  test("performs no Git work when the Git policy is not automatic", () => {
    const fixture = makeFixture("manual");
    commitUpstream(fixture, "remote");
    const before = git(fixture.companion, "rev-parse", "HEAD");

    buildBanner({}, fixture.repo, [], { homeDir: fixture.home });

    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
    expect(fs.existsSync(path.join(fixture.home, ".mate"))).toBe(false);
  });

  test("performs no Git work in a managed session", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    const before = git(fixture.companion, "rev-parse", "HEAD");

    buildBanner(
      { MATE_ARTIFACT_PATH: fixture.companion, MATE_REPO_PATH: fixture.repo },
      fixture.repo,
      [],
      { homeDir: fixture.home },
    );

    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
    expect(fs.existsSync(path.join(fixture.home, ".mate"))).toBe(false);
  });

  test("stays inert when no companion resolves", () => {
    const fixture = makeFixture();
    const plain = path.join(fixture.root, "plain");
    fs.mkdirSync(plain);

    const outcome = buildBanner({}, plain, [], { homeDir: fixture.home });

    expect(outcome).toEqual({ exitCode: 0, stdout: "" });
    expect(fs.existsSync(path.join(fixture.home, ".mate"))).toBe(false);
  });
});

describe("an unfinished synchronization is reported to the operator", () => {
  test("names the reason and the recovery command in systemMessage", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    commitCompanion(fixture, "local");

    const message = bannerMessage(
      buildBanner({}, fixture.repo, [], { homeDir: fixture.home }).stdout,
    );

    expect(message).toContain("diverged");
    expect(message).toContain(COMPANION_SYNC_COMMAND);
  });

  test("reports no Git staleness note when the synchronization completes", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");

    const message = bannerMessage(
      buildBanner({}, fixture.repo, [], { homeDir: fixture.home }).stdout,
    );

    expect(message).not.toContain(COMPANION_SYNC_COMMAND);
  });

  test("the note never reaches the model through additionalContext", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    commitCompanion(fixture, "local");

    const banner = bannerMessage(
      buildBanner({}, fixture.repo, [], { homeDir: fixture.home }).stdout,
    );
    expect(banner).toContain(COMPANION_SYNC_COMMAND);

    const guidance = buildSessionGuidance({}, fixture.repo).stdout;
    expect(guidance).not.toContain(COMPANION_SYNC_COMMAND);
    expect(guidance).not.toContain("synchronization unfinished");
  });
});

describe("session start is never blocked", () => {
  test("exits zero and emits its banner when the remote is unreachable", () => {
    const fixture = makeFixture();
    git(fixture.companion, "remote", "set-url", "origin", path.join(fixture.root, "gone.git"));

    const started = Date.now();
    const outcome = buildBanner({}, fixture.repo, [], { homeDir: fixture.home });
    const elapsed = Date.now() - started;

    expect(outcome.exitCode).toBe(0);
    expect(bannerMessage(outcome.stdout)).toContain(COMPANION_SYNC_COMMAND);
    expect(elapsed).toBeLessThan(TIME_BOUND_MS);
  });

  test("exits zero within the bound when Git work exceeds its timeout", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");

    const started = Date.now();
    const outcome = buildBanner({}, fixture.repo, [], { homeDir: fixture.home, timeoutMs: 1 });
    const elapsed = Date.now() - started;

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("systemMessage");
    expect(elapsed).toBeLessThan(TIME_BOUND_MS);
  });
});
