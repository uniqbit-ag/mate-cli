import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git } from "../../../../test/git-checkouts";
import {
  makeProductRepo,
  productEnvironment,
  PRODUCT,
  type ProductRepo,
} from "../../../../test/product-repo";
import {
  changeLocally,
  makeStagingFixture,
  showAt,
  type StagingFixture,
} from "../../../../test/staging-fixture";
import { companionGit } from "../../../runtime/companion-git";
import { readSubmittedFolders } from "../../../runtime/companion-git-state";
import type { RunOpenSpec } from "../../openspec-cli";
import { readDeliveryRecord, upsertDelivery, writeDeliveryRecord } from "../record";
import { submitChanges, type SubmitOutcome, type SubmitRequest } from "../submit-change";
import { openspecArtifactType } from "./openspec-type";
import {
  dropSubmitted,
  folderDigest,
  hasUnsubmittedWork,
  submitGroups,
  takeSubmitted,
  writeSubmissionState,
  type SubmitDeps,
} from "./submit";

/** Each case runs real Git several times. */
const TIMEOUT = 60_000;
const INBOX = "mate/inbox";
const LOGIN_GROUP = "acme_product/workset/acme-login";
const fixtures: StagingFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function setup(): Promise<StagingFixture> {
  const fixture = await makeStagingFixture();
  fixtures.push(fixture);
  return fixture;
}

function deps(fixture: StagingFixture, extra: Partial<SubmitDeps> = {}): SubmitDeps {
  return { tmpRoot: fixture.root, stateHome: path.join(fixture.root, "home"), ...extra };
}

/** Subjects of `ref` on the remote, newest first; empty when the ref is missing. */
function remoteLog(fixture: StagingFixture, ref: string): string[] {
  try {
    return git(fixture.remote, "log", "--format=%s", ref, "--").trim().split("\n");
  } catch {
    return [];
  }
}

function remoteBranches(fixture: StagingFixture): string[] {
  return git(fixture.remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
    .trim()
    .split("\n");
}

/** Paths the tip commit of `ref` on the remote changes. */
function tipPaths(fixture: StagingFixture, ref: string): string[] {
  return git(fixture.remote, "show", "--name-only", "--format=", ref)
    .trim()
    .split("\n")
    .filter(Boolean);
}

function tipTrailer(fixture: StagingFixture, ref: string, key: string): string {
  return git(fixture.remote, "log", "-1", `--format=%(trailers:key=${key},valueonly)`, ref).trim();
}

/** Rejects pushes to `ref` on the remote the way a protected branch does. */
function protectBranch(fixture: StagingFixture, ref: string): void {
  const hook = path.join(fixture.remote, "hooks", "pre-receive");
  fs.writeFileSync(
    hook,
    `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "${ref}" ]; then\n    echo "GH006: Protected branch update failed for $ref." >&2\n    exit 1\n  fi\ndone\n`,
    { mode: 0o755 },
  );
}

/** Marks `name` submitted, as submit does after its check. */
async function markSubmitted(companion: string, name: string): Promise<void> {
  await writeSubmissionState(path.join(companion, "openspec", "changes", name), name, "submitted");
}

/** Records a block on `name` on the inbox, as a publication does. */
function blockOnInbox(fixture: StagingFixture, name: string): void {
  const publisher = fixture.clone("acme-publisher");
  git(publisher, "checkout", "-q", INBOX);
  fs.appendFileSync(
    path.join(publisher, "openspec", "changes", name, "delivery.yaml"),
    "blocked:\n  reason: acme stale\n  paths: []\n  since: 2026-11-15T10:00:00.000Z\n",
  );
  git(publisher, "commit", "-qam", "block");
  git(publisher, "push", "-q", "origin", INBOX);
}

function stagingDirs(fixture: StagingFixture): string[] {
  return fs.readdirSync(fixture.root).filter((name) => name.startsWith("mate-staging-"));
}

describe("submitGroups", () => {
  test(
    "a group waits for an active slice left out, and is pushed whole in one commit that sets the state",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const head = git(companion, "rev-parse", "HEAD");
      changeLocally(companion, "acme-login-api", { branch: "workset/acme-login" });
      changeLocally(companion, "acme-login-ui", { branch: "workset/acme-login" });

      const waiting = await submitGroups(companion, ["acme-login-api"], deps(fixture));
      expect(waiting).toEqual([
        { group: LOGIN_GROUP, status: "waiting", waitingFor: ["acme-login-ui"] },
      ]);
      expect(remoteBranches(fixture)).toEqual(["main"]);
      // Nothing changed: no change is `submitted` while the remote does not hold it.
      expect(
        fs.readFileSync(
          path.join(companion, "openspec/changes/acme-login-api/delivery.yaml"),
          "utf8",
        ),
      ).not.toContain("state:");

      const [pushed] = await submitGroups(
        companion,
        ["acme-login-api", "acme-login-ui"],
        deps(fixture),
      );
      expect(pushed).toMatchObject({
        status: "pushed",
        push: { changes: ["acme-login-api", "acme-login-ui"], pendingBranch: INBOX },
      });
      expect(remoteLog(fixture, INBOX)).toEqual([
        `chore(openspec): submit ${LOGIN_GROUP}`,
        "chore: start the pending inbox",
      ]);
      expect(
        tipPaths(fixture, INBOX).every(
          (file) =>
            file.startsWith("openspec/changes/acme-login-api/") ||
            file.startsWith("openspec/changes/acme-login-ui/"),
        ),
      ).toBe(true);
      expect(
        showAt(fixture.remote, INBOX, "openspec/changes/acme-login-ui/delivery.yaml"),
      ).toContain("state: submitted");
      expect(tipTrailer(fixture, INBOX, "Mate-Transaction")).not.toBe("");
      expect(tipTrailer(fixture, INBOX, "Mate-Artifact")).toBe("");
      // The inbox is an orphan: no shared history, and main is untouched.
      expect(() => git(fixture.remote, "merge-base", "main", INBOX)).toThrow();
      expect(remoteLog(fixture, "main")).toEqual(["seed"]);
      expect(git(companion, "rev-parse", "HEAD")).toBe(head);
      expect(stagingDirs(fixture)).toEqual([]);

      const digest = await folderDigest(path.join(companion, "openspec/changes/acme-login-ui"));
      expect(
        readSubmittedFolders(companion, path.join(fixture.root, "home"))[
          "openspec/changes/acme-login-ui"
        ],
      ).toMatchObject({ digest });
    },
    TIMEOUT,
  );

  test(
    "a file swapped for a symbolic link after it was listed is not pushed",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const dir = changeLocally(companion, "acme-login");
      await markSubmitted(companion, "acme-login");
      const outside = path.join(fixture.root, "private.txt");
      fs.writeFileSync(outside, "private\n");

      const [refused] = await submitGroups(
        companion,
        ["acme-login"],
        deps(fixture, {
          // Runs after the files are listed and before they are copied.
          newTransaction: () => {
            fs.rmSync(path.join(dir, "proposal.md"));
            fs.symlinkSync(outside, path.join(dir, "proposal.md"));
            return "acme-transaction";
          },
        }),
      );

      expect(refused).toMatchObject({ status: "failed" });
      expect(refused?.push?.detail).toContain("symbolic link");
      expect(remoteBranches(fixture)).toEqual(["main"]);
    },
    TIMEOUT,
  );

  test(
    "an edit made while the push runs is not recorded as submitted",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const dir = changeLocally(companion, "acme-login");
      await markSubmitted(companion, "acme-login");
      let pushedDigest = "";

      const [pushed] = await submitGroups(
        companion,
        ["acme-login"],
        deps(fixture, {
          // Runs after the copy and before the push.
          scan: async (root) => {
            pushedDigest = await folderDigest(path.join(root, "openspec/changes/acme-login"));
            fs.writeFileSync(path.join(dir, "tasks.md"), "edited during the push\n");
            return { skipped: true, findings: [] };
          },
        }),
      );

      expect(pushed).toMatchObject({ status: "pushed" });
      const recorded = readSubmittedFolders(companion, path.join(fixture.root, "home"))[
        "openspec/changes/acme-login"
      ];
      expect(recorded?.digest).toBe(pushedDigest);
      expect(recorded?.digest).not.toBe(await folderDigest(dir));
    },
    TIMEOUT,
  );

  test(
    "pushes to the inbox and leaves the default branch as it was",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      changeLocally(companion, "acme-login", { branch: "workset/acme-login" });
      await markSubmitted(companion, "acme-login");

      const [pushed] = await submitGroups(companion, ["acme-login"], {
        ...deps(fixture),
      });

      expect(pushed).toMatchObject({ status: "pushed", push: { pendingBranch: INBOX } });
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/proposal.md")).toContain(
        "acme widget",
      );
      expect(showAt(fixture.remote, "main", "openspec/changes/acme-login/proposal.md")).toBeNull();
      expect(remoteBranches(fixture)).toEqual(["main", INBOX]);
    },
    TIMEOUT,
  );

  test(
    "a change without a branch is a group of its own and needs no confirmation",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      changeLocally(companion, "acme-glossary");
      changeLocally(companion, "acme-other");
      await markSubmitted(companion, "acme-glossary");

      const [pushed] = await submitGroups(companion, ["acme-glossary"], deps(fixture));

      expect(pushed).toMatchObject({
        group: "change/acme-glossary",
        status: "pushed",
        push: { changes: ["acme-glossary"] },
      });
    },
    TIMEOUT,
  );

  test(
    "submits while the default branch is protected",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      protectBranch(fixture, "refs/heads/main");
      changeLocally(companion, "acme-login");
      await markSubmitted(companion, "acme-login");

      const [pushed] = await submitGroups(companion, ["acme-login"], deps(fixture));

      expect(pushed?.status).toBe("pushed");
    },
    TIMEOUT,
  );

  test(
    "a refused push reports not-permitted",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      protectBranch(fixture, `refs/heads/${INBOX}`);
      const change = changeLocally(companion, "acme-login");
      await markSubmitted(companion, "acme-login");
      const record = fs.readFileSync(path.join(change, "delivery.yaml"), "utf8");

      const [failed] = await submitGroups(companion, ["acme-login"], deps(fixture));

      expect(failed).toMatchObject({ status: "failed", push: { reason: "not-permitted" } });
      expect(failed?.push?.detail).toContain("GH006");
      // The record gains its delta base only once a push succeeds.
      expect(fs.readFileSync(path.join(change, "delivery.yaml"), "utf8")).toBe(record);
    },
    TIMEOUT,
  );

  test(
    "two groups submitted at the same time both arrive, the second rebuilt on the first",
    async () => {
      const fixture = await setup();
      const first = fixture.clone("acme-first");
      const second = fixture.clone("acme-second");
      changeLocally(first, "acme-login");
      changeLocally(second, "acme-billing");
      await markSubmitted(first, "acme-login");
      await markSubmitted(second, "acme-billing");

      const results = await Promise.all([
        submitGroups(first, ["acme-login"], deps(fixture)),
        submitGroups(second, ["acme-billing"], deps(fixture)),
      ]);

      expect(results.map(([result]) => result?.status)).toEqual(["pushed", "pushed"]);
      expect(
        showAt(fixture.remote, INBOX, "openspec/changes/acme-login/proposal.md"),
      ).not.toBeNull();
      expect(
        showAt(fixture.remote, INBOX, "openspec/changes/acme-billing/proposal.md"),
      ).not.toBeNull();
      expect(
        git(fixture.remote, "rev-list", "--max-parents=0", INBOX).trim().split("\n"),
      ).toHaveLength(1);
    },
    TIMEOUT,
  );

  test(
    "a change without a Delivery Record is pushed with one, and gets it locally",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const change = changeLocally(companion, "acme-login");
      fs.rmSync(path.join(change, "delivery.yaml"));

      const [pushed] = await submitGroups(companion, ["acme-login"], deps(fixture));

      expect(pushed).toMatchObject({ status: "pushed", group: "change/acme-login" });
      const remote = showAt(fixture.remote, INBOX, "openspec/changes/acme-login/delivery.yaml");
      expect(remote).toContain("state: submitted");
      expect(fs.readFileSync(path.join(change, "delivery.yaml"), "utf8")).toBe(remote!);
    },
    TIMEOUT,
  );

  test(
    "an unreachable remote fails, and a later run pushes",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const change = changeLocally(companion, "acme-login");
      const record = path.join(change, "delivery.yaml");
      git(companion, "remote", "set-url", "origin", path.join(fixture.root, "missing.git"));

      const [offline] = await submitGroups(companion, ["acme-login"], deps(fixture));
      expect(offline).toMatchObject({ status: "failed", push: { reason: "fetch-failed" } });
      // Not on the remote, so not `submitted`.
      expect(fs.readFileSync(record, "utf8")).not.toContain("state:");
      expect(readSubmittedFolders(companion, path.join(fixture.root, "home"))).toEqual({});

      git(companion, "remote", "set-url", "origin", fixture.remote);
      const [online] = await submitGroups(companion, ["acme-login"], deps(fixture));
      expect(online?.status).toBe("pushed");
    },
    TIMEOUT,
  );

  test(
    "an unchanged resubmit adds no commit; a changed one replaces the folder",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const change = changeLocally(companion, "acme-login", { files: { "notes.md": "one\n" } });
      await markSubmitted(companion, "acme-login");
      await submitGroups(companion, ["acme-login"], deps(fixture));
      const before = remoteLog(fixture, INBOX);

      const [again] = await submitGroups(companion, ["acme-login"], deps(fixture));
      expect(again).toMatchObject({ status: "unchanged", push: { commit: null } });
      expect(remoteLog(fixture, INBOX)).toEqual(before);

      fs.rmSync(path.join(change, "notes.md"));
      fs.writeFileSync(path.join(change, "tasks.md"), "- [x] 1.1 acme\n");
      const [changed] = await submitGroups(companion, ["acme-login"], deps(fixture));
      expect(changed?.status).toBe("pushed");
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/notes.md")).toBeNull();
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/tasks.md")).not.toBeNull();
    },
    TIMEOUT,
  );

  test(
    "an edited resubmit keeps a merge only the inbox records",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const change = changeLocally(companion, "acme-login", {
        branch: "workset/acme-login",
        files: { "notes.md": "one\n" },
      });
      await markSubmitted(companion, "acme-login");
      await submitGroups(companion, ["acme-login"], deps(fixture));

      // Another machine answers the merge question: recorded on the inbox alone.
      const teammate = fixture.clone("acme-teammate");
      git(teammate, "checkout", "-q", "--detach", `origin/${INBOX}`);
      const theirs = path.join(teammate, "openspec", "changes", "acme-login");
      const merge = {
        state: "merged",
        source: "user",
        checkedAt: "2026-11-16T10:00:00.000Z",
      } as const;
      await writeDeliveryRecord(
        theirs,
        upsertDelivery((await readDeliveryRecord(theirs))!, "acme/product", { merge }),
      );
      git(teammate, "commit", "-qam", "record delivery");
      git(teammate, "push", "-q", "origin", `HEAD:${INBOX}`);

      fs.writeFileSync(path.join(change, "notes.md"), "two\n");
      const [again] = await submitGroups(companion, ["acme-login"], deps(fixture));

      expect(again?.status).toBe("pushed");
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/notes.md")).toBe("two\n");
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/delivery.yaml")).toContain(
        "state: merged",
      );
      expect((await readDeliveryRecord(change))?.deliveries[0]?.merge).toEqual(merge);
    },
    TIMEOUT,
  );

  test(
    "a folder holds unsubmitted work until it is submitted, and again once edited",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const change = changeLocally(companion, "acme-login", { files: { "notes.md": "one\n" } });
      const unsubmitted = () => hasUnsubmittedWork(companion, "acme-login", deps(fixture));
      expect(await unsubmitted()).toBe(true);

      await markSubmitted(companion, "acme-login");
      await submitGroups(companion, ["acme-login"], deps(fixture));
      expect(await unsubmitted()).toBe(false);

      fs.writeFileSync(path.join(change, "notes.md"), "two\n");
      expect(await unsubmitted()).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "an edit committed in the checkout since the submit is pushed again",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const change = changeLocally(companion, "acme-login", { files: { "notes.md": "one\n" } });
      await markSubmitted(companion, "acme-login");
      await submitGroups(companion, ["acme-login"], deps(fixture));

      fs.writeFileSync(path.join(change, "notes.md"), "two\n");
      git(companion, "add", "-A");
      git(companion, "commit", "-qm", "acme edit");
      const [edited] = await submitGroups(companion, ["acme-login"], deps(fixture));

      expect(edited?.status).toBe("pushed");
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/notes.md")).toBe("two\n");
    },
    TIMEOUT,
  );

  test(
    "a change name that is not safe in a shell command is refused, and nothing is pushed",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      for (const name of ["acme-[lx]ogin", "acme$(id)", "acme login"]) {
        changeLocally(companion, name, { branch: "workset/acme-pattern" });

        // oxlint-disable-next-line no-await-in-loop -- one submit at a time
        const [pushed] = await submitGroups(companion, [name], deps(fixture));

        expect(pushed).toMatchObject({ status: "failed", push: { reason: "failed" } });
        expect(pushed?.push?.detail).toContain("cannot be submitted under that name");
        // No inbox was started.
        expect(git(fixture.remote, "for-each-ref", `refs/heads/${INBOX}`)).toBe("");
        fs.rmSync(path.join(companion, "openspec/changes", name), { recursive: true });
      }
    },
    TIMEOUT,
  );

  test(
    "records the fetched default tip as the delta base once, and a resubmit clears a block",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const tip = git(fixture.remote, "rev-parse", "main").trim();
      const change = changeLocally(companion, "acme-login");
      await markSubmitted(companion, "acme-login");

      await submitGroups(companion, ["acme-login"], deps(fixture));
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/delivery.yaml")).toContain(
        `specBase: ${tip}`,
      );
      expect((await readDeliveryRecord(change))?.specBase).toBe(tip);

      // A later default tip never replaces it; a block a publication recorded is cleared.
      git(companion, "commit", "-q", "--allow-empty", "-m", "acme later");
      git(companion, "push", "-q", "origin", "HEAD:main");
      blockOnInbox(fixture, "acme-login");
      // Unedited, it stays as the inbox has it; the fixed change is pushed.
      const [unedited] = await submitGroups(companion, ["acme-login"], deps(fixture));
      expect(unedited?.status).toBe("unchanged");
      fs.writeFileSync(path.join(change, "tasks.md"), "- [x] 1.1 acme fixed\n");
      const [again] = await submitGroups(companion, ["acme-login"], deps(fixture));
      expect(again?.status).toBe("pushed");
      const pushed = showAt(fixture.remote, INBOX, "openspec/changes/acme-login/delivery.yaml")!;
      expect(pushed).toContain(`specBase: ${tip}`);
      expect(pushed).not.toContain("blocked:");
      expect((await readDeliveryRecord(change))?.blocked).toBeUndefined();
    },
    TIMEOUT,
  );

  test(
    "a submit drops the recorded submit steps and keeps the other stages'",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const change = changeLocally(companion, "acme-login");
      const record = (await readDeliveryRecord(change))!;
      await writeDeliveryRecord(change, {
        ...record,
        stages: { apply: ["mate-apply-change"], submit: ["acme-pr-check"] },
      });

      await submitGroups(companion, ["acme-login"], deps(fixture));

      const pushed = showAt(fixture.remote, INBOX, "openspec/changes/acme-login/delivery.yaml")!;
      expect(pushed).toContain("state: submitted");
      expect(pushed).not.toContain("acme-pr-check");
      expect((await readDeliveryRecord(change))?.stages).toEqual({ apply: ["mate-apply-change"] });
    },
    TIMEOUT,
  );

  test(
    "a delta base on a local commit is recorded where it left the default branch",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const tip = git(fixture.remote, "rev-parse", "main").trim();
      git(companion, "commit", "-q", "--allow-empty", "-m", "acme local");
      const change = changeLocally(companion, "acme-login");
      const record = (await readDeliveryRecord(change))!;
      await writeDeliveryRecord(change, {
        ...record,
        specBase: git(companion, "rev-parse", "HEAD").trim(),
      });

      await submitGroups(companion, ["acme-login"], deps(fixture));

      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/delivery.yaml")).toContain(
        `specBase: ${tip}`,
      );
    },
    TIMEOUT,
  );

  test(
    "a dropped change comes back when named, and a named one the inbox lost is pushed again",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const change = changeLocally(companion, "acme-login");
      await submitGroups(companion, ["acme-login"], deps(fixture));
      await dropSubmitted(companion, "acme-login", deps(fixture));
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/delivery.yaml")).toBeNull();

      const [back] = await submitGroups(companion, ["acme-login"], deps(fixture));

      expect(back).toMatchObject({ status: "pushed", push: { changes: ["acme-login"] } });
      expect((await readDeliveryRecord(change))?.state).toBe("submitted");
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/delivery.yaml")).toContain(
        "state: submitted",
      );

      // Dropped from another machine: this checkout still reads `submitted`.
      const teammate = fixture.clone("acme-teammate");
      await dropSubmitted(
        teammate,
        "acme-login",
        deps(fixture, { stateHome: path.join(fixture.root, "home-teammate") }),
      );
      const [again] = await submitGroups(companion, ["acme-login"], deps(fixture));
      expect(again?.status).toBe("pushed");
      expect(
        showAt(fixture.remote, INBOX, "openspec/changes/acme-login/proposal.md"),
      ).not.toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a teammate's revision on the inbox is never overwritten by a resubmit",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const change = changeLocally(companion, "acme-login", {
        branch: "workset/acme-login",
        files: { "notes.md": "mine\n" },
      });
      await submitGroups(companion, ["acme-login"], deps(fixture));
      const teammate = fixture.clone("acme-teammate");
      git(teammate, "checkout", "-q", INBOX);
      fs.writeFileSync(path.join(teammate, "openspec/changes/acme-login/notes.md"), "resolved\n");
      git(teammate, "commit", "-qam", "resolve");
      git(teammate, "push", "-q", "origin", INBOX);
      const notes = (): string | null =>
        showAt(fixture.remote, INBOX, "openspec/changes/acme-login/notes.md");

      // Named and unedited: nothing is pushed.
      const [unedited] = await submitGroups(companion, ["acme-login"], deps(fixture));
      expect(unedited?.status).toBe("unchanged");
      expect(notes()).toBe("resolved\n");

      // Only the local record changed, as a refresh leaves it: the inbox's version stands.
      const record = (await readDeliveryRecord(change))!;
      await writeDeliveryRecord(
        change,
        upsertDelivery(record, "acme/product", {
          pr: "https://git.acme.example/acme/product/pull/7",
        }),
      );
      const [recorded] = await submitGroups(companion, ["acme-login"], deps(fixture));
      expect(recorded?.status).toBe("unchanged");
      expect(notes()).toBe("resolved\n");

      // Edited locally too: refused, naming the way out.
      fs.writeFileSync(path.join(change, "notes.md"), "mine, edited\n");
      const [edited] = await submitGroups(companion, ["acme-login"], deps(fixture));
      expect(edited?.status).toBe("failed");
      expect(edited?.push?.detail).toContain("mate artifact take acme-login");
      expect(notes()).toBe("resolved\n");
    },
    TIMEOUT,
  );

  test(
    "a secret finding refuses and pushes nothing",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      changeLocally(companion, "acme-login");
      await markSubmitted(companion, "acme-login");

      const [refused] = await submitGroups(
        companion,
        ["acme-login"],
        deps(fixture, {
          scan: async (_root, paths) => ({
            skipped: false,
            findings: [{ path: paths[0]!, line: 3, ruleId: "acme-token" }],
          }),
        }),
      );

      expect(refused).toMatchObject({ status: "failed", push: { reason: "secret" } });
      expect(refused?.push?.secretFindings?.[0]?.ruleId).toBe("acme-token");
      expect(remoteBranches(fixture)).toEqual(["main"]);
    },
    TIMEOUT,
  );

  test(
    "a teammate's submitted member of the group stays as the inbox has it",
    async () => {
      const fixture = await setup();
      const teammate = fixture.clone("acme-teammate");
      changeLocally(teammate, "acme-login-api", { branch: "workset/acme-login" });
      await markSubmitted(teammate, "acme-login-api");
      await submitGroups(teammate, ["acme-login-api"], deps(fixture));
      const companion = fixture.clone("acme-companion");
      // The teammate resubmits a newer copy; this checkout holds none.
      fs.writeFileSync(
        path.join(teammate, "openspec/changes/acme-login-api/tasks.md"),
        "- [x] newer\n",
      );
      await submitGroups(teammate, ["acme-login-api"], deps(fixture));
      changeLocally(companion, "acme-login-ui", { branch: "workset/acme-login" });
      await markSubmitted(companion, "acme-login-ui");

      const [pushed] = await submitGroups(companion, ["acme-login-ui"], {
        ...deps(fixture),
      });

      expect(pushed).toMatchObject({ status: "pushed", push: { changes: ["acme-login-ui"] } });
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login-api/tasks.md")).toBe(
        "- [x] newer\n",
      );
    },
    TIMEOUT,
  );

  test(
    "a member unchanged since its own submit keeps a teammate's later edit on the pending branch",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      changeLocally(companion, "acme-login-api", { branch: "workset/acme-login" });
      changeLocally(companion, "acme-login-ui", { branch: "workset/acme-login" });
      await markSubmitted(companion, "acme-login-api");
      await markSubmitted(companion, "acme-login-ui");
      await submitGroups(companion, ["acme-login-api"], deps(fixture));
      // A teammate resolves acme-login-api on the pending branch.
      const teammate = fixture.clone("acme-teammate");
      git(teammate, "checkout", "-q", INBOX);
      fs.writeFileSync(
        path.join(teammate, "openspec/changes/acme-login-api/tasks.md"),
        "- [x] resolved\n",
      );
      git(teammate, "add", "-A");
      git(teammate, "commit", "-qm", "resolve");
      git(teammate, "push", "-q", "origin", INBOX);
      fs.writeFileSync(
        path.join(companion, "openspec/changes/acme-login-ui/tasks.md"),
        "- [x] 1.1 acme\n",
      );

      const [pushed] = await submitGroups(companion, ["acme-login-ui"], {
        ...deps(fixture),
      });

      expect(pushed?.push?.changes).toEqual(["acme-login-ui"]);
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login-api/tasks.md")).toBe(
        "- [x] resolved\n",
      );
    },
    TIMEOUT,
  );

  test(
    "a checkout that never submitted or took a change does not overwrite it on the pending branch",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      changeLocally(companion, "acme-login");
      await markSubmitted(companion, "acme-login");
      await submitGroups(companion, ["acme-login"], deps(fixture));
      // Another checkout holds its own copy of the same name, with no submitted record.
      const elsewhere = fixture.clone("acme-elsewhere");
      changeLocally(elsewhere, "acme-login", { files: { "notes.md": "acme stale\n" } });
      const other = deps(fixture, { stateHome: path.join(fixture.root, "other-home") });

      const [refused] = await submitGroups(elsewhere, ["acme-login"], other);

      expect(refused).toMatchObject({ status: "failed", push: { reason: "failed" } });
      expect(refused?.push?.detail).toContain("mate artifact take acme-login");
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/notes.md")).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "files the companion ignores stay out of the pending branch",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      fs.appendFileSync(path.join(companion, ".git", "info", "exclude"), "*.export\n");
      changeLocally(companion, "acme-login", {
        files: { "notes.md": "acme\n", "acme.export": "local export\n" },
      });
      await markSubmitted(companion, "acme-login");

      const [pushed] = await submitGroups(companion, ["acme-login"], deps(fixture));

      expect(pushed?.status).toBe("pushed");
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/notes.md")).toBe("acme\n");
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/acme.export")).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a change folder holding a symbolic link or nested repository is refused before any push",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const linked = changeLocally(companion, "acme-login");
      fs.symlinkSync("proposal.md", path.join(linked, "acme-link.md"));
      const nested = changeLocally(companion, "acme-glossary");
      git(nested, "init", "-q", "acme-nested");
      fs.writeFileSync(path.join(nested, "acme-nested", "file.md"), "acme\n");
      await markSubmitted(companion, "acme-login");
      await markSubmitted(companion, "acme-glossary");

      const [link, repo] = await submitGroups(
        companion,
        ["acme-login", "acme-glossary"],
        deps(fixture),
      );

      expect(link).toMatchObject({ status: "failed", push: { reason: "failed" } });
      expect(link?.push?.detail).toContain("openspec/changes/acme-login/acme-link.md");
      expect(repo).toMatchObject({ status: "failed", push: { reason: "failed" } });
      expect(repo?.push?.detail).toContain("openspec/changes/acme-glossary/acme-nested");
      expect(remoteBranches(fixture)).toEqual(["main"]);
    },
    TIMEOUT,
  );

  test(
    "hooks a teammate pushed to the inbox never run",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      changeLocally(companion, "acme-login");
      await markSubmitted(companion, "acme-login");
      await submitGroups(companion, ["acme-login"], deps(fixture));

      const marker = path.join(fixture.root, "acme-hook-ran");
      const teammate = fixture.clone("acme-teammate");
      git(teammate, "fetch", "-q", "origin", INBOX);
      git(teammate, "switch", "-q", "-c", "inbox", "FETCH_HEAD");
      fs.mkdirSync(path.join(teammate, ".githooks"));
      for (const hook of ["pre-commit", "post-checkout", "pre-push", "reference-transaction"]) {
        fs.writeFileSync(
          path.join(teammate, ".githooks", hook),
          `#!/bin/sh\necho ${hook} >> "${marker}"\n`,
          { mode: 0o755 },
        );
      }
      git(teammate, "add", "-A");
      git(teammate, "commit", "-qm", "acme hooks");
      git(teammate, "push", "-q", "origin", `HEAD:refs/heads/${INBOX}`);

      git(companion, "config", "core.hooksPath", ".githooks");
      changeLocally(companion, "acme-glossary");
      await markSubmitted(companion, "acme-glossary");
      const [pushed] = await submitGroups(companion, ["acme-glossary"], deps(fixture));

      expect(pushed?.status).toBe("pushed");
      expect(fs.existsSync(marker)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "a member Git cannot inspect fails the group instead of overwriting the pending copy",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      changeLocally(companion, "acme-login-api", { branch: "workset/acme-login" });
      changeLocally(companion, "acme-login-ui", { branch: "workset/acme-login" });
      await markSubmitted(companion, "acme-login-api");
      await markSubmitted(companion, "acme-login-ui");
      const failingStatus: SubmitDeps["git"] = (cwd) => {
        const real = companionGit(cwd, { prompt: "never" });
        return {
          ...real,
          run: (args) =>
            args.includes("status")
              ? Promise.resolve({ status: 128, stdout: "", stderr: "index.lock exists" })
              : real.run(args),
        };
      };

      const [group] = await submitGroups(companion, ["acme-login-api"], {
        ...deps(fixture, { git: failingStatus }),
      });

      expect(group).toMatchObject({ status: "failed", push: { reason: "failed" } });
      expect(group?.push?.detail).toContain("acme-login-ui");
      expect(remoteBranches(fixture)).toEqual(["main"]);
    },
    TIMEOUT,
  );
});

const LOGIN_BRANCH = "workset/acme-login";

interface SubmittedLogin {
  companion: string;
  product: ProductRepo;
  /** The folders of the changes already submitted, in the order given. */
  dirs: string[];
  /** The delivery branch's tip when they were submitted. */
  head: string;
}

/** `names` submitted in the login group, and `acme-login-ui` joining it, still active. */
async function submittedLogin(
  fixture: StagingFixture,
  names: string[] = ["acme-login-api"],
): Promise<SubmittedLogin> {
  const companion = fixture.clone("acme-companion");
  const product = makeProductRepo(fixture.root);
  const head = product.commitOn(LOGIN_BRANCH, "login.txt", "login\n");
  const dirs = names.map((name) => changeLocally(companion, name, { branch: LOGIN_BRANCH }));
  await submitGroups(companion, names, deps(fixture));
  changeLocally(companion, "acme-login-ui", { branch: LOGIN_BRANCH });
  return { companion, product, dirs, head };
}

function editProposal(dir: string): void {
  fs.appendFileSync(path.join(dir, "proposal.md"), "\nEdited.\n");
}

function submitUi(
  fixture: StagingFixture,
  login: SubmittedLogin,
  options: {
    runOpenSpec?: RunOpenSpec;
    request?: Partial<SubmitRequest>;
    deps?: Partial<SubmitDeps>;
  } = {},
): Promise<SubmitOutcome> {
  return submitChanges(
    productEnvironment(login.companion, login.product),
    { changes: ["acme-login-ui"], ...options.request },
    {
      ...deps(fixture, options.deps),
      runOpenSpec: options.runOpenSpec ?? recordingOpenSpec(),
    },
  );
}

/** `status` fails; `validate` appends its change to `checked` and fails for `invalid`. */
function recordingOpenSpec(
  options: { checked?: string[]; invalid?: string[]; onCheck?: (change: string) => void } = {},
): RunOpenSpec {
  return async (args) => {
    if (args.includes("status")) return { code: 1, stdout: "", stderr: "no status" };
    const change = args.at(-1)!;
    options.checked?.push(change);
    options.onCheck?.(change);
    return options.invalid?.includes(change)
      ? { code: 1, stdout: "", stderr: `${change}: invalid delta` }
      : { code: 0, stdout: "", stderr: "" };
  };
}

function inboxTip(fixture: StagingFixture): string {
  return git(fixture.remote, "rev-parse", INBOX).trim();
}

describe("submitChanges", () => {
  test(
    "the pushed delivery.yaml records the branch's final head on origin",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const product = makeProductRepo(fixture.root);
      const first = product.commitOn("workset/acme-login", "login.txt", "login\n");
      const change = changeLocally(companion, "acme-login", { branch: "workset/acme-login" });
      fs.writeFileSync(path.join(change, "tasks.md"), "- [x] 1.1 acme\n");
      const linked = await readDeliveryRecord(change);
      await writeDeliveryRecord(change, upsertDelivery(linked!, PRODUCT, { head: first }));
      // A review fix after the branch was linked.
      const final = product.commitOn("workset/acme-login", "login.txt", "login, reviewed\n");

      const outcome = await submitChanges(
        productEnvironment(companion, product),
        { changes: ["acme-login"] },
        {
          ...deps(fixture),
          runOpenSpec: recordingOpenSpec(),
        },
      );

      expect(outcome).toMatchObject({ results: [{ status: "submitted", pushed: true }] });
      const pushed = showAt(fixture.remote, INBOX, "openspec/changes/acme-login/delivery.yaml");
      expect(pushed).toContain(`head: ${final}`);
      expect(pushed).toContain("state: submitted");
    },
    TIMEOUT,
  );

  test(
    "an edited submitted member is refreshed, checked, pushed and listed with the group",
    async () => {
      const fixture = await setup();
      const login = await submittedLogin(fixture);
      editProposal(login.dirs[0]!);
      const final = login.product.commitOn(LOGIN_BRANCH, "login.txt", "login, reviewed\n");
      const before = inboxTip(fixture);
      const checked: string[] = [];

      const outcome = await submitUi(fixture, login, {
        runOpenSpec: recordingOpenSpec({ checked }),
      });

      expect(outcome).toMatchObject({
        results: [
          { change: "acme-login-ui", status: "submitted", pushed: true },
          { change: "acme-login-api", status: "submitted", pushed: true, state: "submitted" },
        ],
      });
      expect(checked).toEqual(["acme-login-ui", "acme-login-api"]);
      expect(git(fixture.remote, "rev-list", "--count", `${before}..${INBOX}`).trim()).toBe("1");
      const touched = tipPaths(fixture, INBOX);
      expect(touched).toContain("openspec/changes/acme-login-api/proposal.md");
      expect(touched).toContain("openspec/changes/acme-login-ui/proposal.md");
      expect(
        showAt(fixture.remote, INBOX, "openspec/changes/acme-login-api/delivery.yaml"),
      ).toContain(`head: ${final}`);
    },
    TIMEOUT,
  );

  test(
    "an edited submitted member that fails its check holds the group back",
    async () => {
      const fixture = await setup();
      const login = await submittedLogin(fixture);
      editProposal(login.dirs[0]!);
      const before = inboxTip(fixture);

      const outcome = await submitUi(fixture, login, {
        runOpenSpec: recordingOpenSpec({ invalid: ["acme-login-api"] }),
      });

      expect(outcome).toMatchObject({
        results: [
          { change: "acme-login-ui", status: "waiting", waitingFor: ["acme-login-api"] },
          {
            change: "acme-login-api",
            status: "failed",
            reason: "check-failed",
            state: "submitted",
            pushed: false,
          },
        ],
      });
      expect(inboxTip(fixture)).toBe(before);
    },
    TIMEOUT,
  );

  test(
    "the archive alias, which pushes nothing, leaves an edited member out of its result",
    async () => {
      const fixture = await setup();
      const login = await submittedLogin(fixture);
      editProposal(login.dirs[0]!);
      const checked: string[] = [];

      const outcome = await submitUi(fixture, login, {
        request: { holdPush: true },
        runOpenSpec: recordingOpenSpec({ checked }),
      });

      expect("results" in outcome && outcome.results.map((result) => result.change)).toEqual([
        "acme-login-ui",
      ]);
      expect(checked).toEqual(["acme-login-ui"]);
    },
    TIMEOUT,
  );

  test(
    "an unedited submitted member stays out of the run",
    async () => {
      const fixture = await setup();
      const login = await submittedLogin(fixture);
      const checked: string[] = [];

      const outcome = await submitUi(fixture, login, {
        runOpenSpec: recordingOpenSpec({ checked }),
      });

      expect(outcome).toMatchObject({ results: [{ change: "acme-login-ui", pushed: true }] });
      expect("results" in outcome && outcome.results).toHaveLength(1);
      expect(checked).toEqual(["acme-login-ui"]);
      expect(tipPaths(fixture, INBOX).filter((file) => file.includes("/acme-login-api/"))).toEqual(
        [],
      );
    },
    TIMEOUT,
  );

  test(
    "an edited member whose delivery cannot be refreshed holds the group back",
    async () => {
      const fixture = await setup();
      const login = await submittedLogin(fixture, ["acme-login-api", "acme-login-db"]);
      const [api, db] = login.dirs;
      editProposal(api!);
      editProposal(db!);
      const before = inboxTip(fixture);

      // Gone once it was found edited, so recording its delivery is refused.
      const outcome = await submitUi(fixture, login, {
        runOpenSpec: recordingOpenSpec({
          onCheck: (change) => {
            if (change === "acme-login-api") fs.rmSync(db!, { recursive: true });
          },
        }),
      });

      expect(outcome).toMatchObject({
        results: [
          { change: "acme-login-ui", status: "waiting", waitingFor: ["acme-login-db"] },
          { change: "acme-login-api", status: "waiting", waitingFor: ["acme-login-db"] },
        ],
      });
      expect(inboxTip(fixture)).toBe(before);
    },
    TIMEOUT,
  );

  test(
    "an edited member nobody named does not accept its block on the pending branch",
    async () => {
      const fixture = await setup();
      const login = await submittedLogin(fixture);
      const base = git(fixture.remote, "rev-parse", "main").trim();
      git(login.companion, "commit", "-q", "--allow-empty", "-m", "acme later");
      git(login.companion, "push", "-q", "origin", "HEAD:main");
      blockOnInbox(fixture, "acme-login-api");
      editProposal(login.dirs[0]!);
      const runOpenSpec = recordingOpenSpec();

      // Its stale part overwrites nothing, so only being named could accept the block.
      const outcome = await submitUi(fixture, login, {
        runOpenSpec,
        deps: {
          artifactType: {
            ...openspecArtifactType(runOpenSpec),
            stale: async (_git, _ref, _source, _base, _current, skip = []) =>
              skip.length > 0
                ? null
                : { capability: "acme", requirement: "Acme", overwrites: false },
          },
        },
      });

      expect(outcome).toMatchObject({
        results: [
          { change: "acme-login-ui", status: "submitted" },
          { change: "acme-login-api", status: "submitted", pushed: true },
        ],
      });
      expect(
        showAt(fixture.remote, INBOX, "openspec/changes/acme-login-api/delivery.yaml"),
      ).toContain(`specBase: ${base}`);
    },
    TIMEOUT,
  );

  test(
    "a member differing only in its local record reports no push when the pending copy stands",
    async () => {
      const fixture = await setup();
      const login = await submittedLogin(fixture);
      const [api] = login.dirs;
      const teammate = fixture.clone("acme-teammate");
      const theirs = deps(fixture, { stateHome: path.join(fixture.root, "home-teammate") });
      await takeSubmitted(teammate, "acme-login-api", theirs);
      const revised = "# acme-login-api, revised\n";
      fs.writeFileSync(path.join(teammate, "openspec/changes/acme-login-api/proposal.md"), revised);
      await submitGroups(teammate, ["acme-login-api"], theirs);
      const record = await readDeliveryRecord(api!);
      await writeDeliveryRecord(api!, upsertDelivery(record!, PRODUCT, { head: login.head }));

      const outcome = await submitUi(fixture, login);

      expect(outcome).toMatchObject({
        results: [
          { change: "acme-login-ui", status: "submitted", pushed: true },
          { change: "acme-login-api", status: "submitted", pushed: false },
        ],
      });
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login-api/proposal.md")).toBe(
        revised,
      );
    },
    TIMEOUT,
  );
});

describe("the checkout after a submit", () => {
  test(
    "is not touched: HEAD stays and the folder stays untracked",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const head = git(companion, "rev-parse", "HEAD");
      changeLocally(companion, "acme-login");
      await markSubmitted(companion, "acme-login");

      const [submission] = await submitGroups(companion, ["acme-login"], deps(fixture));

      expect(submission?.status).toBe("pushed");
      expect(git(companion, "rev-parse", "HEAD")).toBe(head);
      expect(git(companion, "status", "--porcelain").trim()).toBe("?? openspec/changes/");
      git(companion, "pull", "-q", "--ff-only");
    },
    TIMEOUT,
  );

  test(
    "a drop keeps the local copy, untracked and dropped",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const head = git(companion, "rev-parse", "HEAD");
      const change = changeLocally(companion, "acme-login");
      await markSubmitted(companion, "acme-login");
      await submitGroups(companion, ["acme-login"], deps(fixture));

      const dropped = await dropSubmitted(companion, "acme-login", deps(fixture));

      expect(dropped).toMatchObject({ status: "dropped", pushed: true });
      expect(git(companion, "rev-parse", "HEAD")).toBe(head);
      expect(git(companion, "status", "--porcelain").trim()).toBe("?? openspec/changes/");
      expect((await readDeliveryRecord(change))?.state).toBe("dropped");
      expect(fs.existsSync(path.join(change, "proposal.md"))).toBe(true);
    },
    TIMEOUT,
  );
});

describe("dropSubmitted", () => {
  test(
    "removes a submitted change from the pending branch from a machine without a copy",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      changeLocally(companion, "acme-login");
      changeLocally(companion, "acme-glossary");
      await markSubmitted(companion, "acme-login");
      await markSubmitted(companion, "acme-glossary");
      await submitGroups(companion, ["acme-login", "acme-glossary"], deps(fixture));
      const submittedAt = git(fixture.remote, "rev-parse", INBOX).trim();
      const elsewhere = fixture.clone("acme-elsewhere");

      const dropped = await dropSubmitted(elsewhere, "acme-login", deps(fixture));

      expect(dropped).toMatchObject({
        status: "dropped",
        group: "change/acme-login",
        pushed: true,
      });
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/proposal.md")).toBeNull();
      expect(
        showAt(fixture.remote, INBOX, "openspec/changes/acme-glossary/proposal.md"),
      ).not.toBeNull();
      // Recoverable from history.
      expect(
        showAt(fixture.remote, submittedAt, "openspec/changes/acme-login/proposal.md"),
      ).not.toBeNull();
      expect(remoteLog(fixture, INBOX)[0]).toBe("chore(openspec): drop acme-login");
    },
    TIMEOUT,
  );

  test(
    "sets a local copy's state to dropped; refuses a change neither local nor submitted",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const change = changeLocally(companion, "acme-login");

      const local = await dropSubmitted(companion, "acme-login", deps(fixture));
      expect(local).toMatchObject({ status: "dropped", pushed: false });
      expect((await readDeliveryRecord(change))?.state).toBe("dropped");

      expect(await dropSubmitted(companion, "acme-nothing", deps(fixture))).toMatchObject({
        status: "refused",
        reason: "missing",
      });
    },
    TIMEOUT,
  );

  test(
    "drops a local change in a companion without an upstream",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const change = changeLocally(companion, "acme-login");
      git(companion, "remote", "remove", "origin");

      const dropped = await dropSubmitted(companion, "acme-login", deps(fixture));

      expect(dropped).toMatchObject({ status: "dropped", pushed: false, commit: null });
      expect((await readDeliveryRecord(change))?.state).toBe("dropped");
    },
    TIMEOUT,
  );

  test(
    "a failed removal leaves the local state as it was",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const change = changeLocally(companion, "acme-login", { state: "submitted" });
      git(companion, "remote", "set-url", "origin", path.join(fixture.root, "missing.git"));

      const refused = await dropSubmitted(companion, "acme-login", deps(fixture));

      expect(refused).toMatchObject({ status: "refused", reason: "fetch-failed" });
      expect((await readDeliveryRecord(change))?.state).toBe("submitted");
    },
    TIMEOUT,
  );
});

describe("takeSubmitted", () => {
  test(
    "writes a teammate's submitted change into the checkout, untracked, to revise and resubmit",
    async () => {
      const fixture = await setup();
      const teammate = fixture.clone("acme-teammate");
      changeLocally(teammate, "acme-login", { branch: "workset/acme-login" });
      await markSubmitted(teammate, "acme-login");
      await submitGroups(teammate, ["acme-login"], deps(fixture));
      const companion = fixture.clone("acme-companion");
      const mine = deps(fixture, { stateHome: path.join(fixture.root, "home-mine") });

      const taken = await takeSubmitted(companion, "acme-login", mine);

      expect(taken).toMatchObject({ status: "taken", path: "openspec/changes/acme-login" });
      const dir = path.join(companion, "openspec/changes/acme-login");
      expect(fs.readFileSync(path.join(dir, "delivery.yaml"), "utf8")).toContain(
        "state: submitted",
      );
      expect(git(companion, "status", "--porcelain").trim()).toBe("?? openspec/changes/");
      expect(
        readSubmittedFolders(companion, mine.stateHome)["openspec/changes/acme-login"],
      ).toEqual(expect.objectContaining({ digest: await folderDigest(dir) }));

      fs.writeFileSync(path.join(dir, "proposal.md"), "# acme-login, revised\n");
      const [pushed] = await submitGroups(companion, ["acme-login"], mine);

      expect(pushed).toMatchObject({ status: "pushed", push: { changes: ["acme-login"] } });
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/proposal.md")).toBe(
        "# acme-login, revised\n",
      );
    },
    TIMEOUT,
  );

  test(
    "refuses a folder the inbox holds a symbolic link in",
    async () => {
      const fixture = await setup();
      const teammate = fixture.clone("acme-teammate");
      changeLocally(teammate, "acme-login");
      await submitGroups(teammate, ["acme-login"], deps(fixture));
      // Pushed past submit, which refuses links.
      const other = fixture.clone("acme-other");
      git(other, "checkout", "-q", INBOX);
      fs.symlinkSync(
        "../../../../outside",
        path.join(other, "openspec/changes/acme-login/design.md"),
      );
      git(other, "add", "-A");
      git(other, "commit", "-qm", "link");
      git(other, "push", "-q", "origin", INBOX);
      const companion = fixture.clone("acme-companion");
      const mine = deps(fixture, { stateHome: path.join(fixture.root, "home-mine") });

      const taken = await takeSubmitted(companion, "acme-login", mine);

      expect(taken).toMatchObject({ status: "refused", reason: "failed" });
      expect(taken.message).toContain("openspec/changes/acme-login/design.md");
      expect(fs.existsSync(path.join(companion, "openspec/changes/acme-login"))).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "refuses a change the checkout holds edited since, and one that is not submitted",
    async () => {
      const fixture = await setup();
      const teammate = fixture.clone("acme-teammate");
      const change = changeLocally(teammate, "acme-login");
      await markSubmitted(teammate, "acme-login");
      await submitGroups(teammate, ["acme-login"], deps(fixture));
      // An unchanged copy would be caught up; an edited one is kept.
      fs.appendFileSync(path.join(change, "proposal.md"), "\nEdited after submit.\n");
      const before = fs.readFileSync(path.join(change, "proposal.md"), "utf8");

      expect(await takeSubmitted(teammate, "acme-login", deps(fixture))).toMatchObject({
        status: "refused",
        reason: "exists",
      });
      expect(fs.readFileSync(path.join(change, "proposal.md"), "utf8")).toBe(before);
      const companion = fixture.clone("acme-companion");
      expect(await takeSubmitted(companion, "acme-other", deps(fixture))).toMatchObject({
        status: "refused",
        reason: "missing",
      });
      expect(fs.existsSync(path.join(companion, "openspec/changes/acme-other"))).toBe(false);
    },
    TIMEOUT,
  );
  test(
    "commits not pushed yet are recorded as the head and keep the merged branch waiting",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const product = makeProductRepo(fixture.root);
      product.commitOn("workset/acme-login", "login.txt", "login\n");
      product.squashMerge("workset/acme-login", "Login");
      const change = changeLocally(companion, "acme-login", { branch: "workset/acme-login" });
      git(product.clone, "switch", "-q", "workset/acme-login");
      fs.writeFileSync(path.join(product.clone, "logout.txt"), "logout\n");
      git(product.clone, "add", "logout.txt");
      git(product.clone, "commit", "-q", "-m", "logout, not pushed");
      const unpushed = git(product.clone, "rev-parse", "HEAD").trim();

      await submitChanges(
        productEnvironment(companion, product),
        { changes: ["acme-login"] },
        {
          ...deps(fixture),
          runOpenSpec: recordingOpenSpec(),
        },
      );

      const record = await readDeliveryRecord(change);
      expect(record?.deliveries[0]).toMatchObject({ head: unpushed, unpushed: true });
      expect(record?.deliveries[0]?.merge).toBeUndefined();
    },
    TIMEOUT,
  );

  test(
    "a merged branch with uncommitted work in its work tree is refused before the merge is recorded",
    async () => {
      const fixture = await setup();
      const companion = fixture.clone("acme-companion");
      const product = makeProductRepo(fixture.root);
      product.commitOn("workset/acme-login", "login.txt", "login\n");
      product.squashMerge("workset/acme-login", "Login");
      const change = changeLocally(companion, "acme-login", { branch: "workset/acme-login" });
      fs.writeFileSync(path.join(change, "tasks.md"), "- [x] 1.1 acme\n");
      const before = fs.readFileSync(path.join(change, "delivery.yaml"), "utf8");
      const submit = () =>
        submitChanges(
          productEnvironment(companion, product),
          { changes: ["acme-login"] },
          {
            ...deps(fixture),
            runOpenSpec: recordingOpenSpec(),
          },
        );
      git(product.clone, "switch", "-q", "workset/acme-login");
      fs.writeFileSync(path.join(product.clone, "login.txt"), "login, not committed\n");

      const refused = await submit();

      expect(refused).toMatchObject({
        refusal: {
          reason: "uncommitted-work",
          change: "acme-login",
          repository: PRODUCT,
          branch: "workset/acme-login",
        },
      });
      expect(fs.readFileSync(path.join(change, "delivery.yaml"), "utf8")).toBe(before);
      expect(remoteBranches(fixture)).not.toContain(INBOX);

      // The same edit on another branch says nothing about this delivery.
      git(product.clone, "stash", "-q");
      git(product.clone, "switch", "-q", "main");
      fs.writeFileSync(path.join(product.clone, "base.txt"), "base, not committed\n");

      expect(await submit()).toMatchObject({ results: [{ status: "submitted", pushed: true }] });
      expect((await readDeliveryRecord(change))?.deliveries[0]?.merge).toMatchObject({
        state: "merged",
        source: "git",
      });
    },
    TIMEOUT,
  );
});
