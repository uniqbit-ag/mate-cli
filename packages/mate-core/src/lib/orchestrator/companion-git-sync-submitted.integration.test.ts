import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git } from "../../../test/git-checkouts";
import {
  changeLocally,
  makeStagingFixture,
  type StagingFixture,
} from "../../../test/staging-fixture";
import { readSubmittedFolders, updateSubmittedFolders } from "../../runtime/companion-git-state";
import { syncCompanionUnattended } from "../../runtime/companion-sync";
import { folderDigest } from "../../runtime/submitted-arrivals";
import { implicitRecord } from "../workset/inventory";
import { confirmShare, previewShare, readTeamBacklog, refreshTeam } from "../workset/sharing";
import { CompanionGitSync } from "./companion-git-sync";

const TIMEOUT = 60_000;
const LOGIN = "openspec/changes/acme-login";
const fixtures: StagingFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function setup(): Promise<StagingFixture> {
  const fixture = await makeStagingFixture();
  fixtures.push(fixture);
  return fixture;
}

/**
 * `acme-login` written in `mine` and recorded as submitted from it, as submit leaves it; the
 * same folder is copied into `theirs` for the test to push the way submit or publication does.
 */
async function submittedIn(mine: string, theirs: string, home: string): Promise<void> {
  const dir = changeLocally(mine, "acme-login", {
    branch: "workset/acme-login",
    state: "submitted",
  });
  fs.cpSync(dir, path.join(theirs, LOGIN), { recursive: true });
  updateSubmittedFolders(
    mine,
    { [LOGIN]: { digest: await folderDigest(dir), submittedAt: "2026-11-12T10:00:00.000Z" } },
    [],
    home,
  );
}

/** Writes the companion's consent to the unattended sync into `clone`, uncommitted. */
function allowUnattendedSync(clone: string): void {
  const config = path.join(clone, ".mate/config/framework.yaml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, "git: auto\n");
}

/** Pushes `theirs`' work tree to the default branch. */
function pushFrom(theirs: string, message: string): void {
  git(theirs, "add", "-A");
  git(theirs, "commit", "-q", "-m", message);
  git(theirs, "push", "-q", "origin", "HEAD");
}

/**
 * `acme-login` committed and pushed from `mine` while still active, as a team sharing work in
 * progress does, then submitted from it: its Delivery Record changes and `notes.md` is new, both
 * uncommitted in `mine`. `theirs` gets the submitted folder to push.
 */
async function committedThenSubmittedIn(mine: string, theirs: string, home: string): Promise<void> {
  changeLocally(mine, "acme-login", { branch: "workset/acme-login" });
  git(mine, "add", "-A");
  git(mine, "commit", "-q", "-m", "wip acme-login");
  git(mine, "push", "-q", "origin", "HEAD");
  git(theirs, "pull", "-q", "--ff-only");
  const dir = changeLocally(mine, "acme-login", {
    branch: "workset/acme-login",
    state: "submitted",
    files: { "notes.md": "a note\n" },
  });
  fs.cpSync(dir, path.join(theirs, LOGIN), { recursive: true });
  updateSubmittedFolders(
    mine,
    { [LOGIN]: { digest: await folderDigest(dir), submittedAt: "2026-11-12T10:00:00.000Z" } },
    [],
    home,
  );
}

/** Moves `acme-login` in `theirs` to its archive, as publication does. */
function archiveIn(theirs: string): void {
  fs.mkdirSync(path.join(theirs, "openspec/changes/archive"), { recursive: true });
  fs.renameSync(
    path.join(theirs, LOGIN),
    path.join(theirs, "openspec/changes/archive/2026-11-20-acme-login"),
  );
}

describe("companion sync of a submitted change folder committed while active", () => {
  test(
    "an unrelated upstream commit leaves the submitted edits of the tracked folder alone",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await committedThenSubmittedIn(mine, theirs, home);
      git(theirs, "checkout", "-q", "--", ".");
      git(theirs, "clean", "-fdq");
      fs.writeFileSync(path.join(theirs, "acme.md"), "theirs\n");
      pushFrom(theirs, "acme work");

      const result = await new CompanionGitSync({ stateHome: home }).sync(mine);

      expect(result.changed).toBe(true);
      expect(result.discarded).toBeUndefined();
      expect(fs.readFileSync(path.join(mine, LOGIN, "delivery.yaml"), "utf8")).toContain(
        "state: submitted",
      );
      expect(fs.readFileSync(path.join(mine, LOGIN, "notes.md"), "utf8")).toBe("a note\n");
      expect(Object.keys(readSubmittedFolders(mine, home))).toEqual([LOGIN]);
    },
    TIMEOUT,
  );

  test(
    "the published archive arrives and nothing of the tracked folder stays behind",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await committedThenSubmittedIn(mine, theirs, home);
      archiveIn(theirs);
      pushFrom(theirs, "publish acme-login");

      const result = await new CompanionGitSync({ stateHome: home }).sync(mine);

      expect(result.discarded).toEqual([LOGIN]);
      expect(fs.existsSync(path.join(mine, LOGIN))).toBe(false);
      expect(git(mine, "status", "--porcelain").trim()).toBe("");
      expect(readSubmittedFolders(mine, home)).toEqual({});
    },
    TIMEOUT,
  );

  test(
    "the unattended sync fast-forwards over the tracked folder",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const setupClone = fixture.clone("acme-setup");
      allowUnattendedSync(setupClone);
      pushFrom(setupClone, "git: auto");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await committedThenSubmittedIn(mine, theirs, home);
      archiveIn(theirs);
      pushFrom(theirs, "publish acme-login");

      const result = await syncCompanionUnattended(mine, { homeDir: home, ttlMs: 0 });

      expect(result).toMatchObject({ status: "complete", changed: true });
      expect(fs.existsSync(path.join(mine, LOGIN))).toBe(false);
      expect(git(mine, "status", "--porcelain").trim()).toBe("");
    },
    TIMEOUT,
  );

  test(
    "the unattended sync puts the submitted edits back when the fast-forward fails",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const setupClone = fixture.clone("acme-setup");
      allowUnattendedSync(setupClone);
      fs.writeFileSync(path.join(setupClone, "notes.md"), "base\n");
      pushFrom(setupClone, "git: auto");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await committedThenSubmittedIn(mine, theirs, home);
      archiveIn(theirs);
      fs.writeFileSync(path.join(theirs, "notes.md"), "theirs\n");
      pushFrom(theirs, "publish acme-login");
      // A local edit of a file the fast-forward changes stops it.
      fs.writeFileSync(path.join(mine, "notes.md"), "mine\n");

      const outcome = await syncCompanionUnattended(mine, { homeDir: home, ttlMs: 0 });

      expect(outcome.status).toBe("unfinished");
      expect(fs.readFileSync(path.join(mine, LOGIN, "delivery.yaml"), "utf8")).toContain(
        "state: submitted",
      );
      expect(fs.readFileSync(path.join(mine, LOGIN, "notes.md"), "utf8")).toBe("a note\n");
      expect(Object.keys(readSubmittedFolders(mine, home))).toEqual([LOGIN]);
    },
    TIMEOUT,
  );

  test(
    "a tracked folder edited after submit is kept, with a warning",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await committedThenSubmittedIn(mine, theirs, home);
      fs.writeFileSync(path.join(mine, LOGIN, "notes.md"), "edited after submit\n");

      const plan = await new CompanionGitSync({ stateHome: home }).sync(mine);

      expect(plan.discarded).toBeUndefined();
      expect(fs.readFileSync(path.join(mine, LOGIN, "notes.md"), "utf8")).toBe(
        "edited after submit\n",
      );
    },
    TIMEOUT,
  );
});

/** `acme-login` planned in `mine` and shared to the inbox by Work; returns its folder. */
async function sharedFrom(mine: string, home: string): Promise<string> {
  const dir = changeLocally(mine, "acme-login", {
    files: {
      ".openspec.yaml": "schema: mate-v1\n",
      "design.md": "# Design\n",
      "tasks.md": "- [ ] 1.1 Do it\n",
      "specs/acme/spec.md": "## ADDED Requirements\n",
    },
  });
  const entry = {
    id: "acme-login",
    implicit: true,
    record: implicitRecord("acme-login", ["acme-login"], []),
    members: [{ name: "acme-login", kind: "active" as const }],
    diagnostics: [],
    actionable: true,
  };
  await refreshTeam(mine);
  const preview = await previewShare(mine, entry, await readTeamBacklog(mine));
  if ("refusal" in preview) throw new Error(preview.refusal);
  const shared = await confirmShare(
    mine,
    { hash: preview.preview.hash, transactionId: "tx-share" },
    { inventoryEntry: async () => entry, stateHome: home },
  );
  expect(shared.status).toBe("shared");
  return dir;
}

describe("companion sync of a folder Work shared", () => {
  test(
    "the published archive arrives and the unchanged shared folder gives way",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      const dir = await sharedFrom(mine, home);
      expect(readSubmittedFolders(mine, home)[LOGIN]?.shared).toBeString();
      fs.cpSync(dir, path.join(theirs, LOGIN), { recursive: true });
      archiveIn(theirs);
      pushFrom(theirs, "publish acme-login");

      const result = await new CompanionGitSync({ stateHome: home }).sync(mine);

      expect(result.discarded).toEqual([LOGIN]);
      expect(fs.existsSync(path.join(mine, LOGIN))).toBe(false);
      expect(readSubmittedFolders(mine, home)).toEqual({});
    },
    TIMEOUT,
  );

  test(
    "a shared folder edited since keeps its local copy when the archive arrives",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      const dir = await sharedFrom(mine, home);
      fs.cpSync(dir, path.join(theirs, LOGIN), { recursive: true });
      archiveIn(theirs);
      pushFrom(theirs, "publish acme-login");
      fs.writeFileSync(path.join(dir, "design.md"), "# Edited after sharing\n");

      const result = await new CompanionGitSync({ stateHome: home }).sync(mine);

      expect(result.discarded ?? []).toEqual([]);
      expect(fs.readFileSync(path.join(mine, LOGIN, "design.md"), "utf8")).toBe(
        "# Edited after sharing\n",
      );
    },
    TIMEOUT,
  );
});

describe("companion sync of submitted change folders", () => {
  test(
    "the published archive arrives and the unchanged folder is removed",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await submittedIn(mine, theirs, home);
      fs.mkdirSync(path.join(theirs, "openspec/changes/archive"), { recursive: true });
      fs.renameSync(
        path.join(theirs, LOGIN),
        path.join(theirs, "openspec/changes/archive/2026-11-20-acme-login"),
      );
      pushFrom(theirs, "publish acme-login");

      const result = await new CompanionGitSync({ stateHome: home }).sync(mine);

      expect(result.discarded).toEqual([LOGIN]);
      expect(fs.existsSync(path.join(mine, LOGIN))).toBe(false);
      expect(fs.existsSync(path.join(mine, "openspec/changes/archive/2026-11-20-acme-login"))).toBe(
        true,
      );
      expect(readSubmittedFolders(mine, home)).toEqual({});
    },
    TIMEOUT,
  );

  test(
    "a sync that brought the archive and then failed still forgets the submitted record",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const setupClone = fixture.clone("acme-setup");
      fs.writeFileSync(path.join(setupClone, "notes.md"), "base\n");
      pushFrom(setupClone, "notes");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await submittedIn(mine, theirs, home);
      archiveIn(theirs);
      fs.writeFileSync(path.join(theirs, "notes.md"), "theirs\n");
      pushFrom(theirs, "publish acme-login");
      // Stashed for the merge; putting it back conflicts after `HEAD` moved.
      fs.writeFileSync(path.join(mine, "notes.md"), "mine\n");
      const before = git(mine, "rev-parse", "HEAD").trim();

      await expect(new CompanionGitSync({ stateHome: home }).sync(mine)).rejects.toThrow();

      expect(git(mine, "rev-parse", "HEAD").trim()).not.toBe(before);
      expect(readSubmittedFolders(mine, home)).toEqual({});
    },
    TIMEOUT,
  );

  test(
    "a folder edited after submit is kept when its archive arrives, with a warning",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await submittedIn(mine, theirs, home);
      // As submit records it: the archive is this change's by its delta base, whatever was edited.
      const specBase = `specBase: ${git(mine, "rev-parse", "HEAD").trim()}\n`;
      for (const clone of [mine, theirs]) {
        fs.appendFileSync(path.join(clone, LOGIN, "delivery.yaml"), specBase);
      }
      archiveIn(theirs);
      pushFrom(theirs, "publish acme-login");
      fs.writeFileSync(path.join(mine, LOGIN, "proposal.md"), "edited after submit\n");

      const result = await new CompanionGitSync({ stateHome: home }).sync(mine);

      expect(result.discarded).toBeUndefined();
      expect(result.warnings).toEqual([
        `${LOGIN} was edited after it was submitted; kept. Submit acme-login again to share the edit.`,
      ]);
      expect(fs.readFileSync(path.join(mine, LOGIN, "proposal.md"), "utf8")).toBe(
        "edited after submit\n",
      );
    },
    TIMEOUT,
  );

  test(
    "an archive a teammate resolved first still makes the unchanged folder give way",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await submittedIn(mine, theirs, home);
      const head = git(mine, "rev-parse", "HEAD").trim();
      fs.appendFileSync(path.join(mine, LOGIN, "delivery.yaml"), `specBase: ${head}\n`);
      updateSubmittedFolders(
        mine,
        {
          [LOGIN]: {
            digest: await folderDigest(path.join(mine, LOGIN)),
            submittedAt: "2026-11-12T10:00:00.000Z",
          },
        },
        [],
        home,
      );
      // The resolution rewrote a file and took another delta base.
      fs.writeFileSync(path.join(theirs, "notes.md"), "acme\n");
      pushFrom(theirs, "notes");
      const resolvedAt = git(theirs, "rev-parse", "HEAD").trim();
      fs.appendFileSync(path.join(theirs, LOGIN, "delivery.yaml"), `specBase: ${resolvedAt}\n`);
      fs.writeFileSync(path.join(theirs, LOGIN, "proposal.md"), "resolved\n");
      archiveIn(theirs);
      pushFrom(theirs, "publish acme-login");

      const result = await new CompanionGitSync({ stateHome: home }).sync(mine);

      expect(result.discarded).toEqual([LOGIN]);
      expect(fs.existsSync(path.join(mine, LOGIN))).toBe(false);
      expect(readSubmittedFolders(mine, home)).toEqual({});
    },
    TIMEOUT,
  );

  test(
    "the unattended sync discards an unchanged folder whose archive arrives and fast-forwards",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      // The unattended sync runs only with the companion's consent.
      const setupClone = fixture.clone("acme-setup");
      allowUnattendedSync(setupClone);
      pushFrom(setupClone, "git: auto");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await submittedIn(mine, theirs, home);
      archiveIn(theirs);
      pushFrom(theirs, "publish acme-login");

      const outcome = await syncCompanionUnattended(mine, { homeDir: home, ttlMs: 0 });

      expect(outcome).toMatchObject({ status: "complete", changed: true });
      expect(fs.existsSync(path.join(mine, LOGIN))).toBe(false);
      expect(git(mine, "status", "--porcelain").trim()).toBe("");
    },
    TIMEOUT,
  );

  test(
    "the unattended sync puts the discarded folder back when the fast-forward fails",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const setupClone = fixture.clone("acme-setup");
      allowUnattendedSync(setupClone);
      fs.writeFileSync(path.join(setupClone, "notes.md"), "base\n");
      pushFrom(setupClone, "git: auto");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await submittedIn(mine, theirs, home);
      archiveIn(theirs);
      fs.writeFileSync(path.join(theirs, "notes.md"), "theirs\n");
      pushFrom(theirs, "publish acme-login");
      // A local edit of a file the fast-forward changes stops it.
      fs.writeFileSync(path.join(mine, "notes.md"), "mine\n");
      const before = fs.readFileSync(path.join(mine, LOGIN, "proposal.md"), "utf8");

      const outcome = await syncCompanionUnattended(mine, { homeDir: home, ttlMs: 0 });

      expect(outcome.status).toBe("unfinished");
      expect(fs.readFileSync(path.join(mine, LOGIN, "proposal.md"), "utf8")).toBe(before);
      expect(Object.keys(readSubmittedFolders(mine, home))).toEqual([LOGIN]);
    },
    TIMEOUT,
  );

  test(
    "a discard keeps the files the companion ignores",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await submittedIn(mine, theirs, home);
      archiveIn(theirs);
      pushFrom(theirs, "publish acme-login");
      fs.appendFileSync(path.join(mine, ".git/info/exclude"), "*.local.md\n");
      fs.writeFileSync(path.join(mine, LOGIN, "notes.local.md"), "private\n");

      const result = await new CompanionGitSync({ stateHome: home }).sync(mine);

      expect(result).toMatchObject({ changed: true, discarded: [LOGIN] });
      expect(fs.readFileSync(path.join(mine, LOGIN, "notes.local.md"), "utf8")).toBe("private\n");
      expect(git(mine, "status", "--porcelain").trim()).toBe("");
    },
    TIMEOUT,
  );

  test(
    "a later archive of the same name without a spec base and with other content is another change's",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await submittedIn(mine, theirs, home);
      fs.rmSync(path.join(theirs, LOGIN), { recursive: true });
      const unrelated = changeLocally(theirs, "acme-login", { state: "submitted" });
      fs.writeFileSync(path.join(unrelated, "proposal.md"), "## Why\n\nAnother acme login.\n");
      fs.mkdirSync(path.join(theirs, "openspec/changes/archive"), { recursive: true });
      fs.renameSync(unrelated, path.join(theirs, "openspec/changes/archive/2026-11-20-acme-login"));
      pushFrom(theirs, "publish another acme-login");

      const result = await new CompanionGitSync({ stateHome: home }).sync(mine);

      expect(result.discarded).toBeUndefined();
      expect(fs.existsSync(path.join(mine, LOGIN, "proposal.md"))).toBe(true);
      expect(Object.keys(readSubmittedFolders(mine, home))).toEqual([LOGIN]);
    },
    TIMEOUT,
  );

  test(
    "an archive dated the local day before the submit's UTC day still counts",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await submittedIn(mine, theirs, home);
      fs.mkdirSync(path.join(theirs, "openspec/changes/archive"), { recursive: true });
      // Submitted 2026-11-12T10:00Z, published the same evening west of UTC.
      fs.renameSync(
        path.join(theirs, LOGIN),
        path.join(theirs, "openspec/changes/archive/2026-11-11-acme-login"),
      );
      pushFrom(theirs, "publish acme-login");

      const result = await new CompanionGitSync({ stateHome: home }).sync(mine);

      expect(result.discarded).toEqual([LOGIN]);
      expect(readSubmittedFolders(mine, home)).toEqual({});
    },
    TIMEOUT,
  );

  test(
    "an archive of the same name dated before the submit is another change's",
    async () => {
      const fixture = await setup();
      const home = path.join(fixture.root, "home");
      const mine = fixture.clone("acme-mine");
      const theirs = fixture.clone("acme-theirs");
      await submittedIn(mine, theirs, home);
      fs.mkdirSync(path.join(theirs, "openspec/changes/archive"), { recursive: true });
      fs.renameSync(
        path.join(theirs, LOGIN),
        path.join(theirs, "openspec/changes/archive/2026-11-01-acme-login"),
      );
      pushFrom(theirs, "publish an earlier acme-login");

      const result = await new CompanionGitSync({ stateHome: home }).sync(mine);

      expect(result.discarded).toBeUndefined();
      expect(fs.existsSync(path.join(mine, LOGIN))).toBe(true);
      expect(Object.keys(readSubmittedFolders(mine, home))).toEqual([LOGIN]);
    },
    TIMEOUT,
  );
});
