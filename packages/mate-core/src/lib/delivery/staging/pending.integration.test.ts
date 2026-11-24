import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git } from "../../../../test/git-checkouts";
import { makeProductRepo, productEnvironment, PRODUCT } from "../../../../test/product-repo";
import {
  changeLocally,
  makeStagingFixture,
  type StagingFixture,
} from "../../../../test/staging-fixture";
import type { DeliveryEnvironment } from "../environment";
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

describe("merge check", () => {
  const BRANCH = "workset/acme-login";

  /** `acme-login` submitted on a branch of the product repository that was then squash-merged. */
  async function squashMerged() {
    const fixture = await setup();
    const product = makeProductRepo(fixture.root);
    product.commitOn(BRANCH, "login.txt", "login\n");
    const companion = fixture.clone("acme-mine");
    await submit(fixture, companion, "acme-login");
    product.squashMerge(BRANCH, "Acme login (#42)");
    return { fixture, companion, environment: productEnvironment(companion, product) };
  }

  function check(
    fixture: StagingFixture,
    companion: string,
    environment: DeliveryEnvironment,
    budgetMs = 30_000,
  ) {
    return discoverSubmitted(companion, {
      fetch: true,
      tmpRoot: fixture.root,
      stateHome: path.join(fixture.root, "home"),
      checkMerges: { environment, budgetMs },
    });
  }

  test(
    "a squash merge in a linked checkout makes the group publishable without recording it",
    async () => {
      const { fixture, companion, environment } = await squashMerged();
      const tip = git(fixture.remote, "rev-parse", INBOX).trim();

      const found = await check(fixture, companion, environment);

      expect(found.mergeCheck).toEqual({ ran: true, unchecked: [] });
      const group = found.groups[0]!;
      expect(group).toMatchObject({ publishable: true, needsRefresh: true });
      expect(group.changes[0]).toMatchObject({
        delivery: { status: "merged" },
        found: [{ repository: PRODUCT, branch: BRANCH }],
        merges: [],
      });
      expect(git(fixture.remote, "rev-parse", INBOX).trim()).toBe(tip);
    },
    TIMEOUT,
  );

  test(
    "a group publishable through a dependency's found merge needs a refresh too",
    async () => {
      const { fixture, companion, environment } = await squashMerged();
      const ui = changeLocally(companion, "acme-ui", {
        state: "submitted",
        files: { "design.md": "---\ndependsOn: [acme-login]\n---\n" },
      });
      fs.writeFileSync(
        path.join(ui, "delivery.yaml"),
        "version: 1\nchange: acme-ui\nstate: submitted\ndeliveries:\n  - repository: acme/product\n    branch: workset/acme-ui\n    merge:\n      state: merged\n      source: user\n      checkedAt: 2026-11-24T00:00:00Z\n",
      );
      const [submission] = await submitGroups(companion, ["acme-ui"], {
        tmpRoot: fixture.root,
        stateHome: path.join(fixture.root, "home"),
      });
      expect(submission?.status).toBe("pushed");

      const found = await check(fixture, companion, environment);

      const dependent = found.groups.find((group) => group.group.endsWith("workset/acme-ui"));
      expect(dependent).toMatchObject({ publishable: true, needsRefresh: true });
      expect(dependent!.changes[0]!.found).toBeUndefined();
    },
    TIMEOUT,
  );

  test(
    "an unlinked repository and a delivery not checked in time keep their stored state",
    async () => {
      const { fixture, companion, environment } = await squashMerged();
      const unlinked = { ...environment, workingRepo: null, checkoutOf: async () => null };

      const results = [
        await check(fixture, companion, unlinked),
        await check(fixture, companion, environment, 0),
      ];

      for (const result of results) {
        expect(result.groups[0]).toMatchObject({ publishable: false });
        expect(result.groups[0]!.needsRefresh).toBeUndefined();
        expect(result.groups[0]!.changes[0]).toMatchObject({ delivery: { status: "waiting" } });
      }
      expect(results.map((result) => result.mergeCheck?.unchecked)).toEqual([
        [],
        [{ change: "acme-login", repository: PRODUCT, branch: BRANCH }],
      ]);
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
