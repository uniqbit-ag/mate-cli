import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { recordCompanionSync } from "../runtime/companion-git-state";
import { companionLockPath } from "../runtime/companion-lock";
import { OPENCODE_LAUNCH_COMMAND } from "../runtime/companion-sync";
import { mateVersion } from "../runtime/install";
import { computeProjectionStamp, writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import {
  registerCompanionHooks,
  repairCompanionGitOnce,
  resetCompanionGitRepairGuard,
} from "./companion-hooks";
import { readContext, type CompanionContext } from "./companion-policy";
import { resolveOpenCodeGuidance } from "./projected-guidance";
import { makeSshStub, stubSshUrl } from "../../../../test/ssh-stub";
import { trustProjection } from "../../test/trusted-projection";

const tempRoots: string[] = [];
const REGISTRY_CONTENT = "companions: []\n";
/** The session must proceed; this is the ceiling the assertions use. */
const TIME_BOUND_MS = 20_000;
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

function makeFixture(gitPolicy: "auto" | "manual" = "auto"): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-oc-sync-")));
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
  trustProjection({
    home: mateHome({ root }),
    companionPath: companion,
    repoRoot: repo,
    repositoryId: "acme",
  });

  return { root, home, repo, companion, upstream };
}

/**
 * Where the fixture's Mate configuration trusts its projection: apart from
 * `home`, whose `.mate/` folder some tests expect never to appear.
 */
function mateHome(fixture: Pick<Fixture, "root">): string {
  return path.join(fixture.root, "mate-home");
}

/** A plain session's environment. */
function plainEnv(fixture: Fixture): Record<string, string> {
  return { HOME: mateHome(fixture) };
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

function context(
  fixture: Fixture,
  env: Record<string, string> = plainEnv(fixture),
): CompanionContext {
  return {
    ...readContext(env, fixture.repo),
    frameworkName: "mate",
    companionPath: fixture.companion,
    repositoryPath: fixture.repo,
  };
}

beforeEach(() => {
  originalHome = process.env.HOME;
  resetCompanionGitRepairGuard();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  resetCompanionGitRepairGuard();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("the OpenCode plugin repairs the companion at session start", () => {
  test("keeps the event loop responsive during a slow fetch", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    git(
      fixture.companion,
      "remote",
      "set-url",
      "origin",
      stubSshUrl(path.join(fixture.root, "remote.git")),
    );
    const stubEnv = makeSshStub(fixture.root).env("delay");
    const keys = ["GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "MATE_TEST_SSH_MODE", "MATE_TEST_SSH_LOG"];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) process.env[key] = stubEnv[key];
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 50);
    try {
      const notes = await repairCompanionGitOnce(context(fixture));
      expect(notes.join("\n")).toContain("Companion not updated");
    } finally {
      clearInterval(ticker);
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
    expect(ticks).toBeGreaterThanOrEqual(5);
  });

  test("runs the unattended synchronization in an unmanaged session", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");

    const notes = await repairCompanionGitOnce(context(fixture));

    expect(git(fixture.companion, "log", "-1", "--pretty=%s")).toBe("remote");
    expect(notes).toEqual([]);
  });

  test("performs no Git work when the synchronization is not due", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    recordCompanionSync(fixture.companion, new Date(), fixture.home);
    const before = git(fixture.companion, "rev-parse", "HEAD");

    await repairCompanionGitOnce(context(fixture));

    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
  });

  test("performs no Git work when the Git policy is not automatic", async () => {
    const fixture = makeFixture("manual");
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    const before = git(fixture.companion, "rev-parse", "HEAD");

    await repairCompanionGitOnce(context(fixture));

    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
    expect(fs.existsSync(path.join(fixture.home, ".mate"))).toBe(false);
  });

  test("performs no Git work in a managed session", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    const before = git(fixture.companion, "rev-parse", "HEAD");

    await repairCompanionGitOnce(
      context(fixture, { MATE_ARTIFACT_PATH: fixture.companion, MATE_REPO_PATH: fixture.repo }),
    );

    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
    expect(fs.existsSync(path.join(fixture.home, ".mate"))).toBe(false);
  });

  /** The plugin hands `{}` to a session it does not trust; inherited variables must not gate it. */
  test("registerCompanionHooks repairs by the context's session, not process.env", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    const saved = process.env.MATE_REPO_PATH;
    process.env.MATE_REPO_PATH = "/other/repo";
    const api = {
      location: { directory: fixture.repo },
      tool: { hook: async () => {} },
    };
    try {
      await registerCompanionHooks(api as never, context(fixture), {});
    } finally {
      if (saved === undefined) delete process.env.MATE_REPO_PATH;
      else process.env.MATE_REPO_PATH = saved;
    }

    expect(git(fixture.companion, "log", "-1", "--pretty=%s")).toBe("remote");
  });

  test("repairs Git for a companion-scoped managed session without a repository", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");

    const notes = await repairCompanionGitOnce({
      ...context(fixture, { MATE_ARTIFACT_PATH: fixture.companion, MATE_GIT_AUTO_MODE: "1" }),
      repositoryPath: "",
    });

    expect(notes).toEqual([]);
    expect(git(fixture.companion, "log", "-1", "--pretty=%s")).toBe("remote");
  });

  test("does not repair Git for a companion-scoped launch that bypasses sync", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    const before = git(fixture.companion, "rev-parse", "HEAD");

    await repairCompanionGitOnce({
      ...context(fixture, { MATE_ARTIFACT_PATH: fixture.companion, MATE_GIT_AUTO_MODE: "0" }),
      repositoryPath: "",
    });

    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
  });

  test("stays inert when no companion resolves", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;

    const notes = await repairCompanionGitOnce({ ...context(fixture), companionPath: "" });

    expect(notes).toEqual([]);
    expect(fs.existsSync(path.join(fixture.home, ".mate"))).toBe(false);
  });

  test("attempts the synchronization at most once per session", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");

    await repairCompanionGitOnce(context(fixture));
    const head = git(fixture.companion, "rev-parse", "HEAD");

    commitUpstream(fixture, "second");
    await repairCompanionGitOnce(context(fixture));

    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(head);
  });
});

describe("an unfinished synchronization reaches the operator only", () => {
  test("returns the reason and the command as operator notes", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    commitCompanion(fixture, "local");

    const notes = await repairCompanionGitOnce(context(fixture));

    expect(notes[0]).toContain("diverged");
    expect(notes[0]).toContain(OPENCODE_LAUNCH_COMMAND);
  });

  test("surfaces the note beside the projection staleness note", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    commitCompanion(fixture, "local");

    await repairCompanionGitOnce(context(fixture));

    // The TUI renders `stalenessLines`; the Git note joins the projection note
    // there rather than in any model-visible payload.
    const resolved = readContext(plainEnv(fixture), fixture.repo);
    expect(resolved.companionPath).toBe(fixture.companion);
    expect(resolved.stalenessLines.join("\n")).toContain(OPENCODE_LAUNCH_COMMAND);
  });

  test("surfaces no note when the synchronization completes", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");

    const notes = await repairCompanionGitOnce(context(fixture));

    expect(notes).toEqual([]);
  });

  test("no guidance payload delivered to the model carries the note", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    commitCompanion(fixture, "local");

    const notes = await repairCompanionGitOnce(context(fixture));
    expect(notes[0]).toContain(OPENCODE_LAUNCH_COMMAND);

    const guidance = resolveOpenCodeGuidance(plainEnv(fixture), fixture.repo);
    const payload = JSON.stringify(guidance ?? {});
    expect(payload).not.toContain(OPENCODE_LAUNCH_COMMAND);
    expect(payload).not.toContain("synchronization unfinished");
  });
});

describe("the repair yields to Session Prepare", () => {
  test("does nothing in a repository wrapped for OpenCode", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    fs.writeFileSync(
      path.join(fixture.repo, ".mate", "runtime-documents.json"),
      JSON.stringify({ documents: { ".opencode/opencode.json": [] } }),
    );
    const before = git(fixture.companion, "rev-parse", "origin/main");

    const notes = await repairCompanionGitOnce(context(fixture));

    expect(notes).toEqual([]);
    expect(git(fixture.companion, "rev-parse", "origin/main")).toBe(before);
  });

  test("skips at once, without a note, while another sync holds the lock", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    const lockPath = companionLockPath(fixture.companion);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(process.pid));
    const before = git(fixture.companion, "rev-parse", "HEAD");

    const started = Date.now();
    const notes = await repairCompanionGitOnce(context(fixture));

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(notes).toEqual([]);
    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
  });

  test("still repairs a projection not wrapped for OpenCode", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");

    await repairCompanionGitOnce(context(fixture));

    expect(git(fixture.companion, "log", "-1", "--pretty=%s")).toBe("remote");
  });
});

describe("session start is never blocked", () => {
  test("proceeds within the time bound when the remote is unreachable", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    git(fixture.companion, "remote", "set-url", "origin", path.join(fixture.root, "gone.git"));

    const started = Date.now();
    const notes = await repairCompanionGitOnce(context(fixture));
    const elapsed = Date.now() - started;

    expect(notes[0]).toContain(OPENCODE_LAUNCH_COMMAND);
    expect(elapsed).toBeLessThan(TIME_BOUND_MS);
  });
});
