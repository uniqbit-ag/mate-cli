import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { recordCompanionSync } from "../runtime/companion-git-state";
import { COMPANION_SYNC_COMMAND } from "../runtime/companion-sync";
import { mateVersion } from "../runtime/install";
import { computeProjectionStamp, writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { repairCompanionGitOnce, resetCompanionGitRepairGuard } from "./companion-hooks";
import { readContext, type CompanionContext } from "./companion-policy";
import { resolveOpenCodeGuidance } from "./projected-guidance";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-oc-sync-"));
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

function context(fixture: Fixture): CompanionContext {
  return {
    ...readContext({}, fixture.repo),
    frameworkName: "mate",
    companionPath: fixture.companion,
    repositoryPath: fixture.repo,
  };
}

interface Toast {
  title: string;
  message: string;
}

function fakeClient(toasts: Toast[]): {
  tui: { showToast: (input: { body: Toast }) => Promise<void> };
} {
  return {
    tui: {
      showToast: (input: { body: Toast }) => {
        toasts.push(input.body);
        return Promise.resolve();
      },
    },
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
  test("runs the unattended synchronization in an unmanaged session", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");

    const toasts: Toast[] = [];
    const notes = await repairCompanionGitOnce(context(fixture), fakeClient(toasts) as never, {});

    expect(git(fixture.companion, "log", "-1", "--pretty=%s")).toBe("remote");
    expect(notes).toEqual([]);
    expect(toasts).toEqual([]);
  });

  test("performs no Git work when the synchronization is not due", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    recordCompanionSync(fixture.companion, new Date(), fixture.home);
    const before = git(fixture.companion, "rev-parse", "HEAD");

    await repairCompanionGitOnce(context(fixture), undefined, {});

    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
  });

  test("performs no Git work when the Git policy is not automatic", async () => {
    const fixture = makeFixture("manual");
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    const before = git(fixture.companion, "rev-parse", "HEAD");

    await repairCompanionGitOnce(context(fixture), undefined, {});

    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
    expect(fs.existsSync(path.join(fixture.home, ".mate"))).toBe(false);
  });

  test("performs no Git work in a managed session", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    const before = git(fixture.companion, "rev-parse", "HEAD");

    await repairCompanionGitOnce(context(fixture), undefined, {
      MATE_ARTIFACT_PATH: fixture.companion,
    });

    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(before);
    expect(fs.existsSync(path.join(fixture.home, ".mate"))).toBe(false);
  });

  test("stays inert when no companion resolves", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;

    const notes = await repairCompanionGitOnce(
      { ...context(fixture), companionPath: "" },
      undefined,
      {},
    );

    expect(notes).toEqual([]);
    expect(fs.existsSync(path.join(fixture.home, ".mate"))).toBe(false);
  });

  test("attempts the synchronization at most once per session", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");

    await repairCompanionGitOnce(context(fixture), undefined, {});
    const head = git(fixture.companion, "rev-parse", "HEAD");

    commitUpstream(fixture, "second");
    await repairCompanionGitOnce(context(fixture), undefined, {});

    expect(git(fixture.companion, "rev-parse", "HEAD")).toBe(head);
  });
});

describe("an unfinished synchronization reaches the operator only", () => {
  test("surfaces the reason and the command through the toast", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    commitCompanion(fixture, "local");

    const toasts: Toast[] = [];
    const notes = await repairCompanionGitOnce(context(fixture), fakeClient(toasts) as never, {});

    expect(notes[0]).toContain("diverged");
    expect(notes[0]).toContain(COMPANION_SYNC_COMMAND);
    expect(toasts[0]?.message).toContain(COMPANION_SYNC_COMMAND);
  });

  test("surfaces the note beside the projection staleness note", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    commitCompanion(fixture, "local");

    await repairCompanionGitOnce(context(fixture), undefined, {});

    // The TUI renders `stalenessLines`; the Git note joins the projection note
    // there rather than in any model-visible payload.
    const resolved = readContext({}, fixture.repo);
    expect(resolved.companionPath).toBe(fixture.companion);
    expect(resolved.stalenessLines.join("\n")).toContain(COMPANION_SYNC_COMMAND);
  });

  test("surfaces no note when the synchronization completes", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");

    const toasts: Toast[] = [];
    await repairCompanionGitOnce(context(fixture), fakeClient(toasts) as never, {});

    expect(toasts).toEqual([]);
  });

  test("no guidance payload delivered to the model carries the note", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    commitUpstream(fixture, "remote");
    commitCompanion(fixture, "local");

    const notes = await repairCompanionGitOnce(context(fixture), undefined, {});
    expect(notes[0]).toContain(COMPANION_SYNC_COMMAND);

    const guidance = resolveOpenCodeGuidance({}, fixture.repo);
    const payload = JSON.stringify(guidance ?? {});
    expect(payload).not.toContain(COMPANION_SYNC_COMMAND);
    expect(payload).not.toContain("synchronization unfinished");
  });
});

describe("a broken operator channel costs the session nothing", () => {
  /**
   * The repair is awaited above the plugin's returned hooks, so anything
   * escaping it would cost the session the artifact guard, the finish nudge and
   * the React Doctor scan — to save a synchronization that is optional.
   */
  for (const [name, showToast] of [
    [
      "throws synchronously",
      () => {
        throw new Error("tui unavailable");
      },
    ],
    ["returns a non-thenable", () => undefined],
  ] as const) {
    test(`a client whose showToast ${name}`, async () => {
      const fixture = makeFixture();
      process.env.HOME = fixture.home;
      commitUpstream(fixture, "remote");
      commitCompanion(fixture, "local");

      const notes = await repairCompanionGitOnce(
        context(fixture),
        { tui: { showToast } } as never,
        {},
      );

      expect(notes[0]).toContain(COMPANION_SYNC_COMMAND);
    });
  }
});

describe("session start is never blocked", () => {
  test("proceeds within the time bound when the remote is unreachable", async () => {
    const fixture = makeFixture();
    process.env.HOME = fixture.home;
    git(fixture.companion, "remote", "set-url", "origin", path.join(fixture.root, "gone.git"));

    const started = Date.now();
    const notes = await repairCompanionGitOnce(context(fixture), undefined, {});
    const elapsed = Date.now() - started;

    expect(notes[0]).toContain(COMPANION_SYNC_COMMAND);
    expect(elapsed).toBeLessThan(TIME_BOUND_MS);
  });
});
