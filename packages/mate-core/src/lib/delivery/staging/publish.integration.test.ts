import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git } from "../../../../test/git-checkouts";
import {
  canonicalSpec,
  makeStagingFixture,
  proposeLocally,
  REAL_OPENSPEC,
  recordMerged,
  requirement,
  showAt,
  type ChangeOptions,
  type StagingFixture,
} from "../../../../test/staging-fixture";
import { openspecArtifactType } from "./openspec-type";
import { discoverSubmitted } from "./pending";
import { publicationQueue, publishSubmitted, type PublishDeps } from "./publish";
import { resolveSubmitted } from "./resolve";
import { submitGroups } from "./submit";

/** Each case runs real Git and OpenSpec several times. */
const TIMEOUT = 120_000;
const INBOX = "mate/inbox";
const LOGIN = "acme_product/workset/acme-login";
const fixtures: StagingFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function setup(): Promise<StagingFixture> {
  const fixture = await makeStagingFixture({ widget: canonicalSpec("widget", "Widget renders") });
  fixtures.push(fixture);
  return fixture;
}

function deps(fixture: StagingFixture, extra: Partial<PublishDeps> = {}): PublishDeps {
  return { runOpenSpec: fixture.runOpenSpec, tmpRoot: fixture.root, ...extra };
}

/** Writes `name` as a submitted change and pushes its Delivery Group, as submit does. */
async function submit(
  fixture: StagingFixture,
  companion: string,
  name: string,
  options: ChangeOptions & { specBase?: string },
): Promise<void> {
  proposeLocally(fixture, companion, name, { ...options, state: "submitted" });
  const [submission] = await submitGroups(companion, [name], {
    tmpRoot: fixture.root,
    stateHome: path.join(fixture.root, `home-${path.basename(companion)}`),
  });
  expect(submission?.status).toBe("pushed");
}

/** A MODIFIED delta of `Widget renders` that keeps its `Works` scenario, as OpenSpec requires. */
function modifiedRenders(text: string): string {
  return `## MODIFIED Requirements\n\n### Requirement: Widget renders\n${text}\n**Area:** \`packages/web\`\n\n#### Scenario: Works\n- **WHEN** used\n- **THEN** it works\n`;
}

const mainHead = (fixture: StagingFixture): string =>
  git(fixture.remote, "rev-parse", "main").trim();

function commitCount(fixture: StagingFixture, ref: string): number {
  return Number(git(fixture.remote, "rev-list", "--count", ref).trim());
}

/** Files below `prefix` at `ref` on the remote; empty when the ref is missing. */
function filesAt(fixture: StagingFixture, ref: string, prefix: string): string[] {
  try {
    return git(fixture.remote, "ls-tree", "-r", "--name-only", ref, "--", prefix)
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function archivesOnMain(fixture: StagingFixture): string[] {
  return [
    ...new Set(
      filesAt(fixture, "main", "openspec/changes/archive").map((file) => file.split("/")[3]!),
    ),
  ];
}

/** Rejects pushes to `ref` on the remote the way a protected branch does. */
function protectBranch(fixture: StagingFixture, ref: string): void {
  fs.writeFileSync(
    path.join(fixture.remote, "hooks", "pre-receive"),
    `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "${ref}" ]; then\n    echo "GH006: Protected branch update failed for $ref." >&2\n    exit 1\n  fi\ndone\n`,
    { mode: 0o755 },
  );
}

describe.skipIf(!REAL_OPENSPEC)("publishSubmitted", () => {
  test(
    "a push rejected on both attempts is a conflict to publish again",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-login", {
        branch: "workset/acme-login",
        merged: true,
        deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
      });
      const before = mainHead(fixture);
      // Every push to main is turned away as if main had moved.
      fs.writeFileSync(
        path.join(fixture.remote, "hooks", "pre-receive"),
        `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ]; then\n    echo "Updates were rejected (fetch first)" >&2\n    exit 1\n  fi\ndone\n`,
        { mode: 0o755 },
      );

      const result = await publishSubmitted(mine, LOGIN, deps(fixture));

      expect(result.status).toBe("conflict");
      expect(result.message).toContain("publish again");
      expect(mainHead(fixture)).toBe(before);
    },
    TIMEOUT,
  );

  test(
    "the companion's own commit and push hooks do not abort a publication",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-login", {
        branch: "workset/acme-login",
        merged: true,
        deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
      });
      const hooks = path.join(mine, ".git", "hooks");
      fs.mkdirSync(hooks, { recursive: true });
      for (const hook of ["pre-commit", "commit-msg", "pre-push", "post-checkout"]) {
        fs.writeFileSync(path.join(hooks, hook), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      }

      const result = await publishSubmitted(mine, LOGIN, deps(fixture));

      expect(result.status).toBe("ok");
      expect(result.commit).toBe(mainHead(fixture));
    },
    TIMEOUT,
  );

  test(
    "a teammate publishes a merged Workset whose slices build on each other as one commit",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-login-core", {
        branch: "workset/acme-login",
        merged: true,
        deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
      });
      // Sorts first, but builds on the core slice.
      await submit(fixture, mine, "acme-login-admin", {
        branch: "workset/acme-login",
        merged: true,
        dependsOn: ["acme-login-core"],
        deltas: {
          widget: requirement("MODIFIED", "Widget logs in", "The widget SHALL log in fast."),
        },
      });
      const theirs = fixture.clone("acme-theirs");
      const theirHead = git(theirs, "rev-parse", "HEAD");
      const before = commitCount(fixture, "main");

      const result = await publishSubmitted(theirs, LOGIN, deps(fixture));

      expect(result).toMatchObject({
        status: "ok",
        group: LOGIN,
        changes: ["acme-login-core", "acme-login-admin"],
      });
      const archives = archivesOnMain(fixture);
      expect(result.records).toEqual([
        archives.find((anchor) => anchor.endsWith("-acme-login-core")),
        archives.find((anchor) => anchor.endsWith("-acme-login-admin")),
      ]);
      expect(commitCount(fixture, "main")).toBe(before + 1);
      expect(result.commit).toBe(mainHead(fixture));
      const [subject, artifacts, transaction] = git(
        fixture.remote,
        "log",
        "-1",
        "--format=%s%x09%(trailers:key=Mate-Artifact,valueonly,separator=%x2C)%x09%(trailers:key=Mate-Transaction,valueonly)",
        "main",
      )
        .trim()
        .split("\t");
      expect(subject).toBe(`chore(openspec): publish ${LOGIN}`);
      expect(artifacts).toBe(result.records.map((record) => `openspec/${record}`).join(","));
      expect(transaction).not.toBe("");
      const spec = showAt(fixture.remote, "main", "openspec/specs/widget/spec.md")!;
      expect(spec).toContain("The widget SHALL log in fast.");
      expect(filesAt(fixture, "main", "openspec/changes/acme-login-core")).toEqual([]);
      // The inbox is emptied; no tag is created; the checkout took the published commit.
      expect(filesAt(fixture, INBOX, "openspec/changes")).toEqual([]);
      expect(git(fixture.remote, "tag", "--list").trim()).toBe("");
      expect(git(theirs, "rev-parse", "HEAD")).not.toBe(theirHead);
      expect(git(theirs, "rev-parse", "HEAD").trim()).toBe(mainHead(fixture));
    },
    TIMEOUT,
  );

  test(
    "a change folder the default branch holds from its active days is moved to the archive",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      proposeLocally(fixture, mine, "acme-login", {
        branch: "workset/acme-login",
        merged: true,
        deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
      });
      const dropped = path.join(mine, "openspec/changes/acme-login/acme-notes.md");
      fs.writeFileSync(dropped, "acme\n");
      git(mine, "add", "-A");
      git(mine, "commit", "-q", "-m", "wip acme-login");
      git(mine, "push", "-q", "origin", "HEAD");
      // Removed before the submit: the default branch's copy must not come back.
      fs.rmSync(dropped);
      const [submission] = await submitGroups(mine, ["acme-login"], {
        tmpRoot: fixture.root,
        stateHome: path.join(fixture.root, "home-acme-mine"),
      });
      expect(submission?.status).toBe("pushed");

      const result = await publishSubmitted(
        fixture.clone("acme-theirs"),
        "acme-login",
        deps(fixture),
      );

      expect(result.status).toBe("ok");
      expect(filesAt(fixture, "main", "openspec/changes/acme-login")).toEqual([]);
      const [anchor] = result.records;
      expect(
        showAt(fixture.remote, "main", `openspec/changes/archive/${anchor}/delivery.yaml`),
      ).toContain("state: submitted");
      expect(
        showAt(fixture.remote, "main", `openspec/changes/archive/${anchor}/acme-notes.md`),
      ).toBeNull();
      expect(filesAt(fixture, INBOX, "openspec/changes")).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "the archived record keeps the steps recorded for the change",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      proposeLocally(fixture, mine, "acme-login", {
        branch: "workset/acme-login",
        merged: true,
        deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
      });
      fs.appendFileSync(
        path.join(mine, "openspec/changes/acme-login/delivery.yaml"),
        "stages:\n  apply:\n    - mate-apply-change\n    - acme-verify\n",
      );
      await submitGroups(mine, ["acme-login"], {
        tmpRoot: fixture.root,
        stateHome: path.join(fixture.root, "home-acme-mine"),
      });

      const result = await publishSubmitted(
        fixture.clone("acme-theirs"),
        "acme-login",
        deps(fixture),
      );

      expect(result.status).toBe("ok");
      const [anchor] = result.records;
      const archived = showAt(
        fixture.remote,
        "main",
        `openspec/changes/archive/${anchor}/delivery.yaml`,
      );
      expect(archived).toContain("apply:\n    - mate-apply-change\n    - acme-verify\n");
    },
    TIMEOUT,
  );

  test(
    "the publishing checkout holds the archive and the new specs at once",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-login", {
        branch: "workset/acme-login",
        merged: true,
        deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
      });

      const result = await publishSubmitted(
        mine,
        "acme-login",
        deps(fixture, { stateHome: path.join(fixture.root, "home-acme-mine") }),
      );

      expect(result.status).toBe("ok");
      expect(git(mine, "rev-parse", "HEAD").trim()).toBe(mainHead(fixture));
      expect(git(mine, "status", "--porcelain").trim()).toBe("");
      expect(fs.existsSync(path.join(mine, "openspec", "changes", "acme-login"))).toBe(false);
      expect(
        fs.readFileSync(path.join(mine, "openspec", "specs", "widget", "spec.md"), "utf8"),
      ).toContain("Widget logs in");
      git(mine, "pull", "-q", "--ff-only");
    },
    TIMEOUT,
  );

  test(
    "holds an unmerged group, pushing only the answers given to the pending branch",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-login", {
        branch: "workset/acme-login",
        deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
      });
      const before = mainHead(fixture);

      const result = await publishSubmitted(
        mine,
        LOGIN,
        deps(fixture, {
          settle: async (dir, changes) => {
            for (const change of changes) {
              const file = path.join(dir, "openspec", "changes", change, "delivery.yaml");
              fs.writeFileSync(
                file,
                fs
                  .readFileSync(file, "utf8")
                  .replace(
                    "branch: workset/acme-login\n",
                    "branch: workset/acme-login\n    pr: https://example.com/acme/1\n",
                  ),
              );
            }
            return null;
          },
        }),
      );

      expect(result).toMatchObject({ status: "held", reason: "unmerged" });
      expect(result.message).toContain(`mate: ${LOGIN} is held back: acme-login (waiting`);
      expect(mainHead(fixture)).toBe(before);
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/delivery.yaml")).toContain(
        "pr: https://example.com/acme/1",
      );
    },
    TIMEOUT,
  );

  test(
    "answers holding a secret are refused before they reach the pending branch",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-login", {
        branch: "workset/acme-login",
        deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
      });
      const before = showAt(fixture.remote, INBOX, "openspec/changes/acme-login/delivery.yaml");
      const scanned: string[][] = [];

      const result = await publishSubmitted(
        mine,
        LOGIN,
        deps(fixture, {
          settle: async (dir, changes) => {
            for (const change of changes) {
              fs.appendFileSync(
                path.join(dir, "openspec", "changes", change, "delivery.yaml"),
                "# acme token\n",
              );
            }
            return null;
          },
          scan: async (_root, paths) => {
            scanned.push(paths);
            return {
              skipped: false,
              findings: paths.map((file) => ({ path: file, line: 1, ruleId: "acme-token" })),
            };
          },
        }),
      );

      expect(scanned).toEqual([["openspec/changes/acme-login/delivery.yaml"]]);
      expect(result.secretFindings).toHaveLength(1);
      expect(result.message).toContain("refusing to record the delivery");
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/delivery.yaml")).toBe(
        before,
      );
    },
    TIMEOUT,
  );

  test(
    "publishes a merge confirmed during publication with the change",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-login", {
        branch: "workset/acme-login",
        deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
      });
      const inboxBefore = commitCount(fixture, INBOX);

      const result = await publishSubmitted(
        mine,
        "acme-login",
        deps(fixture, {
          settle: async (dir, changes) => {
            for (const change of changes)
              recordMerged(path.join(dir, "openspec", "changes", change));
            return null;
          },
        }),
      );

      expect(result.status).toBe("ok");
      expect(
        showAt(
          fixture.remote,
          "main",
          `openspec/changes/archive/${result.records[0]}/delivery.yaml`,
        ),
      ).toContain("source: user");
      // Only the clean-up reached the inbox; the answer travelled with the publication.
      expect(commitCount(fixture, INBOX)).toBe(inboxBefore + 1);
    },
    TIMEOUT,
  );

  test(
    "a stale requirement blocks the group visibly until it is resolved from another machine",
    async () => {
      const fixture = await setup();
      const seed = mainHead(fixture);
      const beta = fixture.clone("acme-beta");
      await submit(fixture, beta, "acme-beta", {
        branch: "workset/acme-beta",
        merged: true,
        deltas: { widget: modifiedRenders("The widget SHALL hum.") },
      });
      expect((await publishSubmitted(beta, "acme-beta", deps(fixture))).status).toBe("ok");
      // Written while main was at the seed, submitted only after beta published.
      const alpha = fixture.clone("acme-alpha");
      await submit(fixture, alpha, "acme-alpha", {
        branch: "workset/acme-alpha",
        merged: true,
        specBase: seed,
        deltas: { widget: modifiedRenders("The widget SHALL glow.") },
      });
      const published = mainHead(fixture);

      const result = await publishSubmitted(alpha, "acme-alpha", deps(fixture));

      expect(result).toMatchObject({
        status: "conflict",
        blocked: true,
        conflictedPaths: ["openspec/specs/widget/spec.md"],
        conflict: { change: "acme-alpha", capability: "widget", requirement: "Widget renders" },
      });
      expect(result.conflict!.ours).toContain("glow");
      expect(result.conflict!.theirs).toContain("hum");
      expect(mainHead(fixture)).toBe(published);
      const blocked = showAt(fixture.remote, INBOX, "openspec/changes/acme-alpha/delivery.yaml")!;
      expect(blocked).toContain("blocked:");
      expect(blocked).toContain('"Widget renders" in widget changed on main');

      // Retried for the same reason: no new pending-branch commit.
      const inboxBefore = commitCount(fixture, INBOX);
      expect((await publishSubmitted(alpha, "acme-alpha", deps(fixture))).status).toBe("conflict");
      expect(commitCount(fixture, INBOX)).toBe(inboxBefore);

      // Submitted again by name, unchanged: a modification is not accepted that way.
      const [again] = await submitGroups(alpha, ["acme-alpha"], {
        tmpRoot: fixture.root,
        stateHome: path.join(fixture.root, "home-acme-alpha"),
      });
      expect(again?.status).toBe("unchanged");
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-alpha/delivery.yaml")).toContain(
        `specBase: ${seed}`,
      );

      const [mineView] = (
        await discoverSubmitted(alpha, {
          fetch: true,
          tmpRoot: fixture.root,
          stateHome: path.join(fixture.root, "home-acme-alpha"),
        })
      ).groups;
      expect(mineView).toMatchObject({ group: "acme_product/workset/acme-alpha", blocked: true });
      expect(mineView!.changes[0]).toMatchObject({
        name: "acme-alpha",
        origin: "yours",
        author: "acme-alpha",
      });
      expect(mineView!.changes[0]!.blocked?.reason).toContain("Widget renders");

      const other = fixture.clone("acme-other");
      const [otherView] = (
        await discoverSubmitted(other, {
          fetch: true,
          tmpRoot: fixture.root,
          stateHome: path.join(fixture.root, "home-acme-other"),
        })
      ).groups;
      expect(otherView!.changes[0]).toMatchObject({ origin: "others", author: "acme-alpha" });

      const resolved = await resolveSubmitted(
        other,
        "acme-alpha",
        [
          {
            part: { capability: "widget", requirement: "Widget renders" },
            text: "The widget SHALL glow and hum.\n**Area:** `packages/web`\n\n#### Scenario: Works\n- **WHEN** used\n- **THEN** it works\n",
          },
        ],
        { tmpRoot: fixture.root },
      );
      expect(resolved).toMatchObject({
        status: "resolved",
        group: "acme_product/workset/acme-alpha",
      });
      const record = showAt(fixture.remote, INBOX, "openspec/changes/acme-alpha/delivery.yaml")!;
      expect(record).not.toContain("blocked:");
      expect(record).toContain(`specBase: ${published}`);

      expect((await publishSubmitted(other, "acme-alpha", deps(fixture))).status).toBe("ok");
      expect(showAt(fixture.remote, "main", "openspec/specs/widget/spec.md")).toContain(
        "The widget SHALL glow and hum.",
      );
    },
    TIMEOUT,
  );

  test(
    "a resolution is refused when the requirement changed again after the conflict was reported",
    async () => {
      const fixture = await setup();
      const seed = mainHead(fixture);
      const beta = fixture.clone("acme-beta");
      await submit(fixture, beta, "acme-beta", {
        branch: "workset/acme-beta",
        merged: true,
        deltas: { widget: modifiedRenders("The widget SHALL hum.") },
      });
      expect((await publishSubmitted(beta, "acme-beta", deps(fixture))).status).toBe("ok");
      const alpha = fixture.clone("acme-alpha");
      await submit(fixture, alpha, "acme-alpha", {
        branch: "workset/acme-alpha",
        merged: true,
        specBase: seed,
        deltas: { widget: modifiedRenders("The widget SHALL glow.") },
      });
      const reported = mainHead(fixture);
      expect((await publishSubmitted(alpha, "acme-alpha", deps(fixture))).status).toBe("conflict");
      const record = "openspec/changes/acme-alpha/delivery.yaml";
      expect(showAt(fixture.remote, INBOX, record)).toContain(`tip: ${reported}`);

      // A teammate changes the requirement again before the resolution arrives.
      const gamma = fixture.clone("acme-gamma");
      await submit(fixture, gamma, "acme-gamma", {
        branch: "workset/acme-gamma",
        merged: true,
        deltas: { widget: modifiedRenders("The widget SHALL buzz.") },
      });
      expect((await publishSubmitted(gamma, "acme-gamma", deps(fixture))).status).toBe("ok");
      const part = { capability: "widget", requirement: "Widget renders" };
      const text =
        "The widget SHALL glow and hum.\n**Area:** `packages/web`\n\n#### Scenario: Works\n- **WHEN** used\n- **THEN** it works\n";

      const refused = await resolveSubmitted(alpha, "acme-alpha", [{ part, text }], {
        tmpRoot: fixture.root,
      });

      expect(refused.status).toBe("refused");
      expect(refused.message).toContain("changed again on main");
      expect(showAt(fixture.remote, INBOX, record)).toContain("blocked:");

      // Publishing again reports the current text and moves the block to the new tip.
      const again = await publishSubmitted(alpha, "acme-alpha", deps(fixture));
      expect(again.conflict!.theirs).toContain("buzz");
      expect(showAt(fixture.remote, INBOX, record)).toContain(`tip: ${mainHead(fixture)}`);
      const resolved = await resolveSubmitted(alpha, "acme-alpha", [{ part, text }], {
        tmpRoot: fixture.root,
      });
      expect(resolved.status).toBe("resolved");
    },
    TIMEOUT,
  );

  test(
    "a stale requirement the delta renames and modifies is resolved under its old name",
    async () => {
      const fixture = await setup();
      const seed = mainHead(fixture);
      const beta = fixture.clone("acme-beta");
      await submit(fixture, beta, "acme-beta", {
        branch: "workset/acme-beta",
        merged: true,
        deltas: { widget: modifiedRenders("The widget SHALL hum.") },
      });
      expect((await publishSubmitted(beta, "acme-beta", deps(fixture))).status).toBe("ok");
      const alpha = fixture.clone("acme-alpha");
      const body = (text: string): string =>
        `${text}\n**Area:** \`packages/web\`\n\n#### Scenario: Works\n- **WHEN** used\n- **THEN** it works\n`;
      await submit(fixture, alpha, "acme-alpha", {
        branch: "workset/acme-alpha",
        merged: true,
        specBase: seed,
        deltas: {
          widget: `## RENAMED Requirements\n\n- FROM: \`### Requirement: Widget renders\`\n- TO: \`### Requirement: Widget draws\`\n\n## MODIFIED Requirements\n\n### Requirement: Widget draws\n${body("The widget SHALL glow.")}`,
        },
      });

      const conflict = await publishSubmitted(alpha, "acme-alpha", deps(fixture));
      expect(conflict.status).toBe("conflict");
      expect(conflict.message).toContain("Widget renders");
      expect(conflict.conflict!.ours).toContain("glow");
      expect(conflict.conflict!.theirs).toContain("hum");

      const resolved = await resolveSubmitted(
        alpha,
        "acme-alpha",
        [
          {
            part: { capability: "widget", requirement: "Widget renders" },
            text: body("The widget SHALL glow and hum."),
          },
        ],
        { tmpRoot: fixture.root },
      );
      expect(resolved.status).toBe("resolved");

      expect((await publishSubmitted(alpha, "acme-alpha", deps(fixture))).status).toBe("ok");
      const spec = showAt(fixture.remote, "main", "openspec/specs/widget/spec.md")!;
      expect(spec).toContain("### Requirement: Widget draws");
      expect(spec).toContain("The widget SHALL glow and hum.");
      expect(spec).not.toContain("### Requirement: Widget renders");
    },
    TIMEOUT,
  );

  test(
    "a blocked removal is accepted by submitting the change again by name",
    async () => {
      const fixture = await setup();
      const seed = mainHead(fixture);
      const beta = fixture.clone("acme-beta");
      await submit(fixture, beta, "acme-beta", {
        branch: "workset/acme-beta",
        merged: true,
        deltas: { widget: modifiedRenders("The widget SHALL hum.") },
      });
      expect((await publishSubmitted(beta, "acme-beta", deps(fixture))).status).toBe("ok");
      const alpha = fixture.clone("acme-alpha");
      await submit(fixture, alpha, "acme-alpha", {
        branch: "workset/acme-alpha",
        merged: true,
        specBase: seed,
        deltas: {
          widget: `${requirement("ADDED", "Widget glows", "The widget SHALL glow.")}## REMOVED Requirements\n\n### Requirement: Widget renders\n**Reason**: The acme widget no longer renders.\n**Migration**: None.\n`,
        },
      });
      const published = mainHead(fixture);

      const conflict = await publishSubmitted(alpha, "acme-alpha", deps(fixture));
      expect(conflict).toMatchObject({ status: "conflict", conflict: { ours: null } });
      expect(conflict.message).toContain("submit it again unchanged");

      const [again] = await submitGroups(alpha, ["acme-alpha"], {
        tmpRoot: fixture.root,
        stateHome: path.join(fixture.root, "home-acme-alpha"),
      });
      expect(again?.status).toBe("pushed");
      const record = showAt(fixture.remote, INBOX, "openspec/changes/acme-alpha/delivery.yaml")!;
      expect(record).not.toContain("blocked:");
      expect(record).toContain(`specBase: ${published}`);

      expect((await publishSubmitted(alpha, "acme-alpha", deps(fixture))).status).toBe("ok");
      const spec = showAt(fixture.remote, "main", "openspec/specs/widget/spec.md")!;
      expect(spec).not.toContain("Requirement: Widget renders");
      expect(spec).toContain("Requirement: Widget glows");
    },
    TIMEOUT,
  );

  test(
    "without a held specBase, the delta base is the default tip when the change was submitted",
    async () => {
      const fixture = await setup();
      const alpha = fixture.clone("acme-alpha");
      // A base the default branch does not hold, e.g. a local commit never pushed.
      await submit(fixture, alpha, "acme-alpha", {
        branch: "workset/acme-alpha",
        merged: true,
        specBase: "deadbeef".repeat(5),
        deltas: { widget: modifiedRenders("The widget SHALL glow.") },
      });
      // Commit times have a one-second resolution.
      await Bun.sleep(1100);
      const beta = fixture.clone("acme-beta");
      await submit(fixture, beta, "acme-beta", {
        branch: "workset/acme-beta",
        merged: true,
        deltas: { widget: modifiedRenders("The widget SHALL hum.") },
      });
      expect((await publishSubmitted(beta, "acme-beta", deps(fixture))).status).toBe("ok");

      const first = await publishSubmitted(alpha, "acme-alpha", deps(fixture));
      expect(first).toMatchObject({ status: "conflict", blocked: true });
      // Recording the block does not move the base.
      await Bun.sleep(1100);
      expect((await publishSubmitted(alpha, "acme-alpha", deps(fixture))).status).toBe("conflict");
    },
    TIMEOUT,
  );

  test(
    "an inbox commit dated ahead of this clock dates no delta, so the change is not applied unchecked",
    async () => {
      const fixture = await setup();
      const alpha = fixture.clone("acme-alpha");
      await submit(fixture, alpha, "acme-alpha", {
        branch: "workset/acme-alpha",
        merged: true,
        specBase: "deadbeef".repeat(5),
        deltas: { widget: modifiedRenders("The widget SHALL glow.") },
      });
      // The same inbox tree, committed a day ahead: by its date the delta base would be the tip.
      const tree = git(fixture.remote, "rev-parse", `${INBOX}^{tree}`).trim();
      const parent = git(fixture.remote, "rev-parse", `${INBOX}^`).trim();
      const identity = ["-c", "user.name=acme", "-c", "user.email=acme@example.com"];
      const ahead = execFileSync(
        "git",
        [...identity, "commit-tree", tree, "-p", parent, "-m", "submit"],
        {
          cwd: fixture.remote,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_COMMITTER_DATE: `${Math.floor(Date.now() / 1000) + 86_400} +0000`,
          },
        },
      ).trim();
      git(fixture.remote, "update-ref", `refs/heads/${INBOX}`, ahead);
      const before = mainHead(fixture);

      const result = await publishSubmitted(alpha, "acme-alpha", deps(fixture));

      expect(result.status).toBe("conflict");
      expect(result.message).toContain("is unknown");
      expect(mainHead(fixture)).toBe(before);
    },
    TIMEOUT,
  );

  test(
    "names whose answer a publication rests on, and holds it back where nobody's word is taken",
    async () => {
      const fixture = await setup();
      const alpha = fixture.clone("acme-alpha");
      await submit(fixture, alpha, "acme-login", {
        branch: "workset/acme-login",
        merged: true,
        deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
      });
      const beta = fixture.clone("acme-beta");
      const before = mainHead(fixture);
      const claim = { change: "acme-login", state: "merged", source: "user" };

      const own = await discoverSubmitted(alpha, { fetch: true, tmpRoot: fixture.root });
      expect(own.groups[0]?.changes[0]?.merges).toMatchObject([{ yours: true }]);

      const held = await publishSubmitted(beta, LOGIN, deps(fixture, { ownAnswersOnly: true }));
      expect(held).toMatchObject({
        status: "held",
        reason: "unconfirmed-merge",
        merges: [{ ...claim, recordedBy: "acme-alpha", yours: false }],
      });
      expect(mainHead(fixture)).toBe(before);

      const published = await publishSubmitted(beta, LOGIN, deps(fixture));
      expect(published).toMatchObject({ status: "ok", merges: [{ ...claim, yours: false }] });
      expect(published.message).toContain("answer of acme-alpha");
    },
    TIMEOUT,
  );

  test(
    "a block the publisher records leaves a merge answer its recorder's",
    async () => {
      const fixture = await setup();
      const alpha = fixture.clone("acme-alpha");
      await submit(fixture, alpha, "acme-alpha", {
        branch: "workset/acme-alpha",
        merged: true,
        deltas: { widget: modifiedRenders("The widget SHALL glow.") },
      });
      const beta = fixture.clone("acme-beta");
      await submit(fixture, beta, "acme-beta", {
        branch: "workset/acme-beta",
        merged: true,
        deltas: { widget: modifiedRenders("The widget SHALL hum.") },
      });
      expect((await publishSubmitted(beta, "acme-beta", deps(fixture))).status).toBe("ok");
      // Beta's commit on the inbox now is the newest to touch alpha's record.
      expect(await publishSubmitted(beta, "acme-alpha", deps(fixture))).toMatchObject({
        status: "conflict",
        blocked: true,
      });

      const seen = await discoverSubmitted(beta, { fetch: true, tmpRoot: fixture.root });
      expect(seen.groups[0]?.changes[0]?.merges).toMatchObject([
        { source: "user", recordedBy: "acme-alpha", yours: false },
      ]);
    },
    TIMEOUT,
  );

  test(
    "a delta that drops a scenario names OpenSpec's reason",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-login-ui", {
        branch: "workset/acme-login",
        merged: true,
        // Its own scenario replaces `Works`, which the current requirement still has.
        deltas: { widget: requirement("MODIFIED", "Widget renders", "The widget SHALL glow.") },
      });

      const result = await publishSubmitted(mine, LOGIN, deps(fixture));

      expect(result.status).toBe("conflict");
      expect(result.message).toContain('not present in the modified block: "Works"');
    },
    TIMEOUT,
  );

  test(
    "a validation failure pushes nothing and keeps the submitted change",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-login", {
        branch: "workset/acme-login",
        merged: true,
        deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
      });
      const before = mainHead(fixture);
      const type = {
        ...openspecArtifactType(fixture.runOpenSpec),
        validate: async (_dir: string, files: readonly string[]) =>
          files.includes("openspec/specs/widget/spec.md")
            ? { path: "openspec/specs/widget/spec.md", detail: "acme error" }
            : null,
      };

      const result = await publishSubmitted(mine, LOGIN, deps(fixture, { artifactType: type }));

      expect(result).toMatchObject({
        status: "conflict",
        conflictedPaths: ["openspec/specs/widget/spec.md"],
      });
      expect(result.message).toContain("openspec/specs/widget/spec.md is invalid");
      expect(mainHead(fixture)).toBe(before);
      expect(
        showAt(fixture.remote, INBOX, "openspec/changes/acme-login/proposal.md"),
      ).not.toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a user whose push to the default branch is refused awaits a publisher",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-login", {
        branch: "workset/acme-login",
        merged: true,
        deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
      });
      protectBranch(fixture, "refs/heads/main");
      const before = mainHead(fixture);

      const result = await publishSubmitted(mine, LOGIN, deps(fixture));

      expect(result.status).toBe("awaiting-publisher");
      expect(mainHead(fixture)).toBe(before);
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-login/delivery.yaml")).toContain(
        "state: submitted",
      );
    },
    TIMEOUT,
  );

  test(
    "an interrupted inbox clean-up is finished by the next publication without archiving again",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-login", {
        branch: "workset/acme-login",
        merged: true,
        deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
      });
      protectBranch(fixture, `refs/heads/${INBOX}`);

      const first = await publishSubmitted(mine, LOGIN, deps(fixture));
      expect(first.status).toBe("ok");
      expect(first.warnings.join(" ")).toContain("stay in the inbox");
      expect(
        showAt(fixture.remote, INBOX, "openspec/changes/acme-login/proposal.md"),
      ).not.toBeNull();
      const published = mainHead(fixture);
      // Pending discovery no longer lists it.
      expect(
        (await discoverSubmitted(mine, { fetch: true, tmpRoot: fixture.root })).groups,
      ).toEqual([]);

      fs.rmSync(path.join(fixture.remote, "hooks", "pre-receive"));
      const again = await publishSubmitted(mine, LOGIN, deps(fixture));

      expect(again).toMatchObject({ status: "ok", alreadyPublished: true });
      expect(mainHead(fixture)).toBe(published);
      expect(filesAt(fixture, INBOX, "openspec/changes")).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "holds a group whose dependency in another group cannot publish, and publishes both once it can",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-ui", {
        branch: "workset/acme-ui",
        merged: true,
        dependsOn: ["acme-api"],
        deltas: { widget: requirement("MODIFIED", "Widget calls", "The widget SHALL call fast.") },
      });
      await submit(fixture, mine, "acme-api", {
        branch: "workset/acme-api",
        deltas: { widget: requirement("ADDED", "Widget calls", "The widget SHALL call.") },
      });
      const before = mainHead(fixture);

      const held = await publishSubmitted(mine, "acme-ui", deps(fixture));
      expect(held).toMatchObject({
        status: "held",
        reason: "dependency-unpublished",
        heldBy: ["acme-api"],
      });
      expect(mainHead(fixture)).toBe(before);
      const view = await discoverSubmitted(mine, { fetch: true, tmpRoot: fixture.root });
      expect(
        view.groups.find((group) => group.group === "acme_product/workset/acme-ui"),
      ).toMatchObject({
        publishable: false,
        heldBy: ["acme-api"],
      });
      // `--all` publishes dependencies first, whatever the submit order.
      expect(await publicationQueue(mine, { tmpRoot: fixture.root })).toEqual({
        groups: ["acme_product/workset/acme-api", "acme_product/workset/acme-ui"],
        fresh: true,
      });

      const result = await publishSubmitted(
        mine,
        "acme-ui",
        deps(fixture, {
          settleDependency: async (dir, changes) => {
            for (const change of changes)
              recordMerged(path.join(dir, "openspec", "changes", change));
            return null;
          },
        }),
      );

      expect(result.status).toBe("ok");
      expect(result.dependencies?.map((entry) => [entry.group, entry.status])).toEqual([
        ["acme_product/workset/acme-api", "ok"],
      ]);
      expect(commitCount(fixture, "main")).toBe(commitCount(fixture, before) + 2);
      expect(showAt(fixture.remote, "main", "openspec/specs/widget/spec.md")).toContain(
        "The widget SHALL call fast.",
      );
    },
    TIMEOUT,
  );

  test(
    "resolve refuses a requirement removed on the default branch",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-alpha", {
        branch: "workset/acme-alpha",
        merged: true,
        specBase: mainHead(fixture),
        deltas: { widget: modifiedRenders("The widget SHALL glow.") },
      });
      const type = {
        ...openspecArtifactType(fixture.runOpenSpec),
        stale: async () => ({
          capability: "widget",
          requirement: "Widget renders",
          versions: { base: "was", ours: "glow", theirs: null },
        }),
      };
      const inboxBefore = commitCount(fixture, INBOX);

      const result = await resolveSubmitted(
        mine,
        "acme-alpha",
        [
          {
            part: { capability: "widget", requirement: "Widget renders" },
            text: "The widget SHALL glow.",
          },
        ],
        { tmpRoot: fixture.root, artifactType: type },
      );

      expect(result.status).toBe("refused");
      expect(result.message).toContain("was removed from widget on main");
      expect(commitCount(fixture, INBOX)).toBe(inboxBefore);
    },
    TIMEOUT,
  );

  test(
    "resolve refuses while another stale requirement of the change is not resolved with it",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-alpha", {
        branch: "workset/acme-alpha",
        merged: true,
        specBase: mainHead(fixture),
        deltas: { widget: modifiedRenders("The widget SHALL glow.") },
      });
      const renders = { capability: "widget", requirement: "Widget renders" };
      const sizes = { capability: "widget", requirement: "Widget sizes" };
      const versions = { base: "was", ours: "glow", theirs: "hum" };
      const type = {
        ...openspecArtifactType(fixture.runOpenSpec),
        stale: async (
          _git: unknown,
          _ref: string,
          _path: string,
          _base: string,
          _current: string,
          skip: readonly { capability: string; requirement: string }[] = [],
        ) =>
          [renders, sizes]
            .map((part) => ({ ...part, versions }))
            .find((part) => !skip.some((done) => done.requirement === part.requirement)) ?? null,
        resolve: async () => null,
      };
      const inboxBefore = commitCount(fixture, INBOX);

      const result = await resolveSubmitted(
        mine,
        "acme-alpha",
        [{ part: renders, text: "The widget SHALL glow and hum." }],
        { tmpRoot: fixture.root, artifactType: type },
      );

      expect(result).toMatchObject({ status: "refused", unresolved: [sizes] });
      expect(result.message).toContain('widget "Widget sizes"');
      expect(commitCount(fixture, INBOX)).toBe(inboxBefore);
      expect(showAt(fixture.remote, INBOX, "openspec/changes/acme-alpha/delivery.yaml")).toContain(
        `specBase: ${mainHead(fixture)}`,
      );
    },
    TIMEOUT,
  );

  test(
    "resolve is not held back by a stale requirement the delta does not overwrite",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-alpha", {
        branch: "workset/acme-alpha",
        merged: true,
        specBase: mainHead(fixture),
        deltas: { widget: modifiedRenders("The widget SHALL glow.") },
      });
      const renders = { capability: "widget", requirement: "Widget renders" };
      const stale = [
        { ...renders, overwrites: true, versions: { base: "was", ours: "glow", theirs: "hum" } },
        {
          capability: "widget",
          requirement: "Widget sizes",
          overwrites: false,
          versions: { base: "was", ours: null, theirs: "hum" },
        },
      ];
      const type = {
        ...openspecArtifactType(fixture.runOpenSpec),
        stale: async (
          _git: unknown,
          _ref: string,
          _path: string,
          _base: string,
          _current: string,
          skip: readonly { capability: string; requirement: string }[] = [],
        ) =>
          stale.find((part) => !skip.some((done) => done.requirement === part.requirement)) ?? null,
      };

      const result = await resolveSubmitted(
        mine,
        "acme-alpha",
        [
          {
            part: renders,
            text: "The widget SHALL glow and hum.\n**Area:** `packages/web`\n\n#### Scenario: Works\n- **WHEN** used\n- **THEN** it works\n",
          },
        ],
        { tmpRoot: fixture.root, artifactType: type },
      );

      expect(result.status).toBe("resolved");
    },
    TIMEOUT,
  );

  test(
    "pending discovery keeps the last known state, marked stale, when the fetch fails",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      await submit(fixture, mine, "acme-login", {
        branch: "workset/acme-login",
        deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
      });
      git(mine, "remote", "set-url", "origin", path.join(fixture.root, "acme-missing.git"));

      const view = await discoverSubmitted(mine, { fetch: true, tmpRoot: fixture.root });

      expect(view.stale).toBe(true);
      expect(view.error).toContain("fetching the companion remote failed");
      expect(view.groups.map((group) => group.group)).toEqual([LOGIN]);
    },
    TIMEOUT,
  );
});
