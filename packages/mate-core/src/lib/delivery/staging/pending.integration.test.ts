import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git } from "../../../../test/git-checkouts";
import {
  changeLocally,
  makeStagingFixture,
  type StagingFixture,
} from "../../../../test/staging-fixture";
import { discoverSubmitted } from "./pending";
import { submitGroups } from "./submit";

/** Each case runs real Git several times. */
const TIMEOUT = 60_000;
const INBOX = "mate/inbox";
const fixtures: StagingFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function setup(): Promise<StagingFixture> {
  const fixture = await makeStagingFixture();
  fixtures.push(fixture);
  return fixture;
}

/** Submits `name` from `companion`. */
async function submit(fixture: StagingFixture, companion: string, name: string): Promise<void> {
  changeLocally(companion, name, { branch: `workset/${name}`, state: "submitted" });
  const [submission] = await submitGroups(companion, [name], {
    tmpRoot: fixture.root,
    stateHome: path.join(fixture.root, "home"),
  });
  expect(submission?.status).toBe("pushed");
}

function discover(fixture: StagingFixture, companion: string) {
  return discoverSubmitted(companion, {
    fetch: true,
    tmpRoot: fixture.root,
    stateHome: path.join(fixture.root, "home"),
  });
}

describe("discoverSubmitted", () => {
  test(
    "lists a submitted change with where to read it, also without a fetch",
    async () => {
      const fixture = await setup();
      await submit(fixture, fixture.clone("acme-mine"), "acme-login");
      const other = fixture.clone("acme-other");

      const found = await discover(fixture, other);

      expect(found).toMatchObject({
        stale: false,
        pendingBranch: INBOX,
        ref: `refs/remotes/origin/${INBOX}`,
      });
      expect(found.error).toBeUndefined();
      expect(found.groups.map((group) => group.group)).toEqual(["acme_product/workset/acme-login"]);
      const change = found.groups[0]!.changes[0]!;
      expect(change.path).toBe("openspec/changes/acme-login");
      expect(git(other, "show", `${found.ref}:${change.path}/delivery.yaml`)).toContain(
        "state: submitted",
      );

      // Without a fetch the last fetched refs answer.
      const offline = await discoverSubmitted(other, { fetch: false, tmpRoot: fixture.root });
      expect(offline.stale).toBe(true);
      expect(offline.groups).toHaveLength(1);
    },
    TIMEOUT,
  );

  test(
    "a remote without an inbox lists nothing",
    async () => {
      const fixture = await setup();

      const found = await discover(fixture, fixture.clone("acme-other"));

      expect(found).toMatchObject({ stale: false, pendingBranch: INBOX, groups: [] });
      expect(found.error).toBeUndefined();
    },
    TIMEOUT,
  );

  test(
    "a change the default branch already archived is no longer listed",
    async () => {
      const fixture = await setup();
      await submit(fixture, fixture.clone("acme-mine"), "acme-login");
      // As a publication leaves it when its second push, emptying the inbox, failed.
      const admin = fixture.clone("acme-publisher");
      git(admin, "fetch", "-q", "origin", `${INBOX}:refs/remotes/origin/${INBOX}`);
      git(admin, "checkout", "-q", `origin/${INBOX}`, "--", "openspec/changes/acme-login");
      fs.mkdirSync(path.join(admin, "openspec", "changes", "archive"), { recursive: true });
      git(
        admin,
        "mv",
        "openspec/changes/acme-login",
        "openspec/changes/archive/2026-11-01-acme-login",
      );
      git(admin, "commit", "-qm", "publish acme-login");
      git(admin, "push", "-q", "origin", "HEAD:main");

      expect((await discover(fixture, fixture.clone("acme-other"))).groups).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("touched parts", () => {
  test(
    "a submitted change lists the requirements it rewrites or removes",
    async () => {
      const fixture = await setup();
      const mine = fixture.clone("acme-mine");
      changeLocally(mine, "acme-login", {
        files: {
          "specs/acme-auth/spec.md":
            "## MODIFIED Requirements\n\n### Requirement: Login\nThe acme-auth SHALL work.\n\n## ADDED Requirements\n\n### Requirement: Logout\nThe acme-auth SHALL end.\n\n## REMOVED Requirements\n\n### Requirement: Token\n",
        },
      });
      await submit(fixture, mine, "acme-login");

      const found = await discover(fixture, fixture.clone("acme-other"));

      expect(found.groups[0]?.changes[0]).toMatchObject({
        name: "acme-login",
        origin: "others",
        author: "acme-mine",
        touches: [
          { capability: "acme-auth", requirement: "Login" },
          { capability: "acme-auth", requirement: "Token" },
        ],
      });
    },
    TIMEOUT,
  );
});
