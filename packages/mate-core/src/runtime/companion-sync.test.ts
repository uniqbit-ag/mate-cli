import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { CompanionGitSync } from "../lib/orchestrator/companion-git-sync";
import {
  companionForkState,
  resolveUpstreamTargetSync,
  resolveUpstreamTargetWith,
  runGitSync,
} from "./companion-git";
import {
  COMPANION_SYNC_TTL_MS,
  isCompanionSyncDue,
  readCompanionGitRecord,
  recordCompanionSync,
  recordCompanionSyncUnfinished,
} from "./companion-git-state";
import {
  cachedCompanionForkState,
  companionForkRefusal,
  COMPANION_SYNC_COMMAND,
  persistedCompanionGitStalenessLines,
  syncCompanionUnattended,
  unattendedSyncStalenessLines,
} from "./companion-sync";
import { emptyCompanionPolicy } from "./policy";

const tempRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

interface Fixture {
  root: string;
  home: string;
  companion: string;
  upstream: string;
}

function writePolicy(companion: string, git: "auto" | "manual" | null): void {
  const configPath = path.join(companion, ".mate", "config", "framework.yaml");
  if (git === null) {
    fs.rmSync(configPath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `git: ${git}\n`, "utf8");
}

function makeFixture(gitPolicy: "auto" | "manual" | null = "auto"): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-sync-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const remote = path.join(root, "remote.git");
  const companion = path.join(root, "companion");
  const upstream = path.join(root, "upstream");
  fs.mkdirSync(home);

  git(root, "init", "--bare", "-q", "--initial-branch=main", remote);
  fs.mkdirSync(companion);
  git(companion, "init", "-q", "--initial-branch=main");
  git(companion, "config", "user.email", "mate-tests@example.com");
  git(companion, "config", "user.name", "Mate Tests");
  fs.writeFileSync(path.join(companion, "notes.md"), "base\n");
  writePolicy(companion, gitPolicy);
  git(companion, "add", ".");
  git(companion, "commit", "-qm", "base");
  git(companion, "remote", "add", "origin", remote);
  git(companion, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", remote, upstream);
  git(upstream, "config", "user.email", "mate-tests@example.com");
  git(upstream, "config", "user.name", "Mate Tests");

  return { root, home, companion, upstream };
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

/** Fetch without merging, so local refs know the upstream moved. */
function fetchOnly(fixture: Fixture): void {
  git(fixture.companion, "fetch", "-q", "origin", "main");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("shared upstream-ref resolution", () => {
  test("resolves the configured @{u} ref", () => {
    const { companion } = makeFixture();
    expect(resolveUpstreamTargetSync(companion)).toEqual({
      remote: "origin",
      branch: "main",
      ref: "origin/main",
    });
  });

  test("falls back to origin/main when no upstream is configured", () => {
    const { companion } = makeFixture();
    git(companion, "branch", "--unset-upstream");
    expect(resolveUpstreamTargetSync(companion)?.ref).toBe("origin/main");
  });

  test("yields null outside a Git working tree", () => {
    const { root } = makeFixture();
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    expect(resolveUpstreamTargetSync(plain)).toBeNull();
  });

  test("both halves resolve the same ref for the same companion", async () => {
    const { companion } = makeFixture();
    const sync = resolveUpstreamTargetSync(companion);
    const asynchronous = await resolveUpstreamTargetWith((args) =>
      Promise.resolve(runGitSync(companion, args)),
    );
    expect(asynchronous).toEqual(sync);

    // The attended half must agree too: it delegates to the same resolution.
    const seen: string[][] = [];
    const attended = new CompanionGitSync((args, cwd) => {
      seen.push([...args]);
      return Promise.resolve(runGitSync(cwd, args));
    });
    await attended.sync(companion).catch(() => undefined);
    expect(seen.some((args) => args.join(" ").includes("@{u}"))).toBe(true);
  });
});

describe("fork check", () => {
  test("reports a fork when ahead and behind", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    commitCompanion(fixture, "local");
    fetchOnly(fixture);
    expect(companionForkState(fixture.companion)).toEqual({ ahead: 1, behind: 1, forked: true });
  });

  test("reports no fork when only ahead", () => {
    const fixture = makeFixture();
    commitCompanion(fixture, "local");
    expect(companionForkState(fixture.companion)).toEqual({ ahead: 1, behind: 0, forked: false });
  });

  test("reports no fork when only behind", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    fetchOnly(fixture);
    expect(companionForkState(fixture.companion)).toEqual({ ahead: 0, behind: 1, forked: false });
  });

  test("reports no fork when no upstream ref exists locally", () => {
    const fixture = makeFixture();
    git(fixture.companion, "branch", "--unset-upstream");
    git(fixture.companion, "remote", "remove", "origin");
    git(fixture.companion, "update-ref", "-d", "refs/remotes/origin/main");
    expect(companionForkState(fixture.companion)).toBeNull();
  });

  test("reports no fork outside a Git working tree", () => {
    const { root } = makeFixture();
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    expect(companionForkState(plain)).toBeNull();
  });

  test("reports no fork when Git cannot be run", () => {
    const fixture = makeFixture();
    expect(companionForkState(path.join(fixture.root, "missing"))).toBeNull();
  });

  test("reports no fork when the bound is exceeded", () => {
    const fixture = makeFixture();
    expect(companionForkState(fixture.companion, 1)).toBeNull();
  });
});

describe("the consent gate", () => {
  test("emptyCompanionPolicy keeps gitAutoMode false", () => {
    expect(emptyCompanionPolicy().gitAutoMode).toBe(false);
  });

  test("does nothing when Git handling is not automatic", () => {
    const fixture = makeFixture("manual");
    commitUpstream(fixture, "remote");
    const before = git(fixture.companion, "rev-parse", "HEAD");

    const outcome = syncCompanionUnattended(fixture.companion, { homeDir: fixture.home });

    expect(outcome.status).toBe("not-applicable");
    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
    expect(fs.existsSync(path.join(fixture.home, ".mate"))).toBe(false);
  });

  test("treats an absent companion configuration as not automatic", () => {
    const fixture = makeFixture(null);
    expect(syncCompanionUnattended(fixture.companion, { homeDir: fixture.home }).status).toBe(
      "not-applicable",
    );
  });

  test("treats a malformed companion configuration as not automatic", () => {
    const fixture = makeFixture();
    fs.writeFileSync(
      path.join(fixture.companion, ".mate", "config", "framework.yaml"),
      "git: [unclosed\n",
      "utf8",
    );
    expect(syncCompanionUnattended(fixture.companion, { homeDir: fixture.home }).status).toBe(
      "not-applicable",
    );
  });

  test("is checked before the freshness interval", () => {
    const fixture = makeFixture("manual");
    recordCompanionSync(fixture.companion, new Date(), fixture.home);
    expect(syncCompanionUnattended(fixture.companion, { homeDir: fixture.home }).status).toBe(
      "not-applicable",
    );
  });
});

describe("the unattended mode", () => {
  test("fast-forwards a companion that is strictly behind", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");

    const outcome = syncCompanionUnattended(fixture.companion, { homeDir: fixture.home });

    expect(outcome.status).toBe("complete");
    expect(outcome.changed).toBe(true);
    expect(git(fixture.companion, "log", "-1", "--pretty=%s")).toBe("remote");
  });

  test("changes nothing when already up to date", () => {
    const fixture = makeFixture();
    const outcome = syncCompanionUnattended(fixture.companion, { homeDir: fixture.home });
    expect(outcome).toMatchObject({ status: "complete", changed: false });
  });

  test("treats an ahead-only companion as complete without merging", () => {
    const fixture = makeFixture();
    commitCompanion(fixture, "local");
    const before = git(fixture.companion, "rev-parse", "HEAD");

    const outcome = syncCompanionUnattended(fixture.companion, { homeDir: fixture.home });

    expect(outcome).toMatchObject({ status: "complete", changed: false });
    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
  });

  test("reports divergence without merging", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    commitCompanion(fixture, "local");
    const before = git(fixture.companion, "rev-parse", "HEAD");

    const outcome = syncCompanionUnattended(fixture.companion, { homeDir: fixture.home });

    expect(outcome.status).toBe("unfinished");
    expect(outcome.reason).toContain("diverged");
    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
    expect(git(fixture.companion, "status", "--porcelain=v1")).toBe("");
  });

  test("reports a dirty tree that blocks the fast-forward", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    fs.appendFileSync(path.join(fixture.companion, "notes.md"), "local edit\n");
    const before = git(fixture.companion, "rev-parse", "HEAD");

    const outcome = syncCompanionUnattended(fixture.companion, { homeDir: fixture.home });

    expect(outcome.status).toBe("unfinished");
    expect(outcome.reason).toContain("local changes");
    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
  });

  test("reports an in-progress merge without touching it", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    fs.writeFileSync(path.join(fixture.companion, ".git", "MERGE_HEAD"), "deadbeef\n");

    const outcome = syncCompanionUnattended(fixture.companion, { homeDir: fixture.home });

    expect(outcome.status).toBe("unfinished");
    expect(outcome.reason).toContain("MERGE_HEAD");
  });

  test("reports an unreachable remote and never raises", () => {
    const fixture = makeFixture();
    git(fixture.companion, "remote", "set-url", "origin", path.join(fixture.root, "gone.git"));

    const outcome = syncCompanionUnattended(fixture.companion, { homeDir: fixture.home });

    expect(outcome.status).toBe("unfinished");
    expect(outcome.reason).toContain("unable to fetch");
  });

  test("never pushes", () => {
    const fixture = makeFixture();
    commitCompanion(fixture, "local");
    syncCompanionUnattended(fixture.companion, { homeDir: fixture.home });
    expect(git(fixture.upstream, "log", "-1", "--pretty=%s")).toBe("base");
  });

  test("reports rather than raising outside a Git working tree", () => {
    const { root, home } = makeFixture();
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    fs.mkdirSync(path.join(plain, ".mate", "config"), { recursive: true });
    fs.writeFileSync(path.join(plain, ".mate", "config", "framework.yaml"), "git: auto\n");
    expect(syncCompanionUnattended(plain, { homeDir: home }).status).toBe("not-applicable");
  });

  test("abandons work that exceeds the bound", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    const outcome = syncCompanionUnattended(fixture.companion, {
      homeDir: fixture.home,
      timeoutMs: 1,
    });
    expect(outcome.status).not.toBe("complete");
  });
});

describe("the completion record", () => {
  test("records a completed synchronization outside the companion", () => {
    const fixture = makeFixture();
    const statusBefore = git(fixture.companion, "status", "--porcelain=v1");

    syncCompanionUnattended(fixture.companion, { homeDir: fixture.home });

    expect(readCompanionGitRecord(fixture.companion, fixture.home).syncedAt).toBeString();
    expect(git(fixture.companion, "status", "--porcelain=v1")).toBe(statusBefore);
    expect(fs.existsSync(path.join(fixture.companion, ".mate", "companion-git-state"))).toBe(false);
  });

  test("a missing record means a synchronization is due", () => {
    const fixture = makeFixture();
    expect(
      isCompanionSyncDue(fixture.companion, COMPANION_SYNC_TTL_MS, new Date(), fixture.home),
    ).toBe(true);
  });

  test("a record inside the interval means it is not due", () => {
    const fixture = makeFixture();
    const now = new Date("2026-01-01T12:00:00.000Z");
    recordCompanionSync(fixture.companion, now, fixture.home);
    expect(
      isCompanionSyncDue(fixture.companion, 60_000, new Date(now.getTime() + 1_000), fixture.home),
    ).toBe(false);
  });

  test("a record older than the interval means it is due", () => {
    const fixture = makeFixture();
    const now = new Date("2026-01-01T12:00:00.000Z");
    recordCompanionSync(fixture.companion, now, fixture.home);
    expect(
      isCompanionSyncDue(fixture.companion, 60_000, new Date(now.getTime() + 61_000), fixture.home),
    ).toBe(true);
  });

  test("a fresh record short-circuits before any Git work", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    recordCompanionSync(fixture.companion, new Date(), fixture.home);
    const before = git(fixture.companion, "rev-parse", "HEAD");

    const outcome = syncCompanionUnattended(fixture.companion, { homeDir: fixture.home });

    expect(outcome.status).toBe("fresh");
    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
  });

  test("an unfinished run leaves no completion for a later run to trust", () => {
    const fixture = makeFixture();
    const now = new Date("2026-01-01T12:00:00.000Z");
    /** Two sessions share one companion: one completes, the other loses on a lock. */
    recordCompanionSync(fixture.companion, now, fixture.home);
    recordCompanionSyncUnfinished(fixture.companion, "index.lock exists", fixture.home);

    expect(
      isCompanionSyncDue(fixture.companion, 60_000, new Date(now.getTime() + 1_000), fixture.home),
    ).toBe(true);
    expect(persistedCompanionGitStalenessLines(fixture.companion, fixture.home)).toHaveLength(1);
  });

  test("the next completed run clears the unfinished reason", () => {
    const fixture = makeFixture();
    recordCompanionSyncUnfinished(fixture.companion, "index.lock exists", fixture.home);

    const outcome = syncCompanionUnattended(fixture.companion, { homeDir: fixture.home });

    expect(outcome.status).toBe("complete");
    expect(persistedCompanionGitStalenessLines(fixture.companion, fixture.home)).toEqual([]);
  });

  test("the attended path records on completion", async () => {
    const fixture = makeFixture();
    const home = process.env.HOME;
    process.env.HOME = fixture.home;
    try {
      commitUpstream(fixture, "remote");
      await new CompanionGitSync((args, cwd) => Promise.resolve(runGitSync(cwd, args))).sync(
        fixture.companion,
      );
      expect(readCompanionGitRecord(fixture.companion, fixture.home).syncedAt).toBeString();
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  });
});

describe("the shared fork refusal", () => {
  test("refuses in an unmanaged session while the history has forked", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    commitCompanion(fixture, "local");
    fetchOnly(fixture);

    const refusal = companionForkRefusal({}, fixture.companion, { homeDir: fixture.home });

    expect(refusal).toContain("forked");
    expect(refusal).toContain(COMPANION_SYNC_COMMAND);
  });

  test("permits when a launch environment is present", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    commitCompanion(fixture, "local");
    fetchOnly(fixture);

    expect(
      companionForkRefusal({ MATE_ARTIFACT_PATH: fixture.companion }, fixture.companion, {
        homeDir: fixture.home,
      }),
    ).toBeNull();
  });

  test("permits an ahead-only companion", () => {
    const fixture = makeFixture();
    commitCompanion(fixture, "local");
    expect(companionForkRefusal({}, fixture.companion, { homeDir: fixture.home })).toBeNull();
  });

  test("permits a behind-only companion", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    fetchOnly(fixture);
    expect(companionForkRefusal({}, fixture.companion, { homeDir: fixture.home })).toBeNull();
  });

  test("permits when the check cannot complete", () => {
    const { root, home } = makeFixture();
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    expect(companionForkRefusal({}, plain, { homeDir: home })).toBeNull();
  });

  test("caches the verdict for the interval instead of spawning Git per write", () => {
    const fixture = makeFixture();
    commitUpstream(fixture, "remote");
    commitCompanion(fixture, "local");
    fetchOnly(fixture);

    const first = cachedCompanionForkState(fixture.companion, { homeDir: fixture.home });
    expect(first?.forked).toBe(true);

    // The verdict is now cached; a repaired companion still reads as forked
    // until the interval elapses, which is what keeps repeated writes cheap.
    git(fixture.companion, "reset", "-q", "--hard", "origin/main");
    expect(cachedCompanionForkState(fixture.companion, { homeDir: fixture.home })?.forked).toBe(
      true,
    );
    expect(
      cachedCompanionForkState(fixture.companion, { homeDir: fixture.home, ttlMs: 0 })?.forked,
    ).toBe(false);
  });
});

describe("operator-facing staleness lines", () => {
  test("name the reason and the recovery command", () => {
    const lines = unattendedSyncStalenessLines({
      status: "unfinished",
      changed: false,
      companionPath: "/tmp/acme-companion",
      reason: "history has diverged from origin/main",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("history has diverged");
    expect(lines[0]).toContain(COMPANION_SYNC_COMMAND);
  });

  test("are empty for every other outcome", () => {
    for (const status of ["not-applicable", "fresh", "complete"] as const) {
      expect(
        unattendedSyncStalenessLines({ status, changed: false, companionPath: "/tmp/acme" }),
      ).toEqual([]);
    }
  });
});
