import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git } from "../../../../test/git-checkouts";
import { makeProductRepo, productEnvironment, PRODUCT } from "../../../../test/product-repo";
import {
  canonicalSpec,
  makeStagingFixture,
  proposeLocally,
  REAL_OPENSPEC,
  requirement,
  showAt,
  type StagingFixture,
} from "../../../../test/staging-fixture";
import { publishSubmitted } from "./publish";
import { settleLinked } from "./settle-linked";
import { submitGroups } from "./submit";

/** Each case runs real Git and OpenSpec several times. */
const TIMEOUT = 120_000;
const INBOX = "mate/inbox";
const BRANCH = "workset/acme-login";
const RECORD = "openspec/changes/acme-login/delivery.yaml";
const fixtures: StagingFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/** A companion with `acme-login` submitted on `workset/acme-login`, and the product repository. */
async function submitted() {
  const fixture = await makeStagingFixture({ widget: canonicalSpec("widget", "Widget renders") });
  fixtures.push(fixture);
  const product = makeProductRepo(fixture.root);
  const head = product.commitOn(BRANCH, "login.txt", "login\n");
  const companion = fixture.clone("acme-companion");
  proposeLocally(fixture, companion, "acme-login", {
    branch: BRANCH,
    state: "submitted",
    deltas: { widget: requirement("ADDED", "Widget logs in", "The widget SHALL log in.") },
  });
  const [submission] = await submitGroups(companion, ["acme-login"], {
    tmpRoot: fixture.root,
    stateHome: path.join(fixture.root, "home"),
  });
  expect(submission?.status).toBe("pushed");
  const environment = productEnvironment(companion, product);
  return { fixture, product, head, companion, environment };
}

function remoteLog(fixture: StagingFixture, ref: string): string[] {
  return git(fixture.remote, "log", "--format=%s", ref, "--").trim().split("\n");
}

describe("settleLinked", () => {
  test(
    "an aborted settlement pushes nothing",
    async () => {
      const { fixture, product, environment } = await submitted();
      product.squashMerge(BRANCH, "Acme login (#42)");
      const before = remoteLog(fixture, INBOX);

      const result = await settleLinked(environment, {
        tmpRoot: fixture.root,
        signal: AbortSignal.abort(),
      });

      expect(result).toEqual({ recorded: [], warning: null });
      expect(remoteLog(fixture, INBOX)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "a push refused at its last moment leaves the pending branch as it was",
    async () => {
      const { fixture, product, environment } = await submitted();
      product.squashMerge(BRANCH, "Acme login (#42)");
      const before = remoteLog(fixture, INBOX);
      let asked = 0;

      const result = await settleLinked(environment, {
        tmpRoot: fixture.root,
        claimPush: () => {
          asked += 1;
          return false;
        },
      });

      expect(asked).toBe(1);
      expect(result).toEqual({ recorded: [], warning: null });
      expect(remoteLog(fixture, INBOX)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "the submitter's session records the squash merge on the pending branch",
    async () => {
      const { fixture, product, head, environment } = await submitted();
      const squash = product.squashMerge(BRANCH, "Acme login (#42)");

      const result = await settleLinked(environment, { tmpRoot: fixture.root });

      expect(result).toEqual({ recorded: ["acme-login"], warning: null });
      const record = showAt(fixture.remote, INBOX, RECORD) ?? "";
      expect(record).toContain("state: merged");
      expect(record).toContain("source: git");
      expect(record).toContain(`mergeCommit: ${squash}`);
      expect(record).toContain(`head: ${head}`);
      expect(record).toContain(`repository: ${PRODUCT}`);
      expect(remoteLog(fixture, INBOX)[0]).toBe("chore(openspec): record merges of acme-login");
      expect(
        git(
          fixture.remote,
          "log",
          "-1",
          "--format=%(trailers:key=Mate-Transaction,valueonly)",
          INBOX,
        ).trim(),
      ).not.toBe("");

      // Recorded once: the next settlement finds nothing new.
      const again = await settleLinked(environment, { tmpRoot: fixture.root });
      expect(again).toEqual({ recorded: [], warning: null });
    },
    TIMEOUT,
  );

  test(
    "a merge record with a secret finding is not pushed, and the next settlement tries again",
    async () => {
      const { fixture, product, environment } = await submitted();
      product.squashMerge(BRANCH, "Acme login (#42)");
      const before = remoteLog(fixture, INBOX);

      const refused = await settleLinked(environment, {
        tmpRoot: fixture.root,
        scan: async (_root, paths) => ({
          skipped: false,
          findings: [{ path: paths[0]!, line: 4, ruleId: "acme-token" }],
        }),
      });

      expect(refused.recorded).toEqual([]);
      expect(refused.warning).toContain(`${RECORD} (acme-token)`);
      expect(refused.warning).toContain("the next settlement tries again");
      expect(remoteLog(fixture, INBOX)).toEqual(before);

      const scanned: string[][] = [];
      const clean = await settleLinked(environment, {
        tmpRoot: fixture.root,
        scan: async (_root, paths) => {
          scanned.push(paths);
          return { skipped: false, findings: [] };
        },
      });

      expect(clean).toEqual({ recorded: ["acme-login"], warning: null });
      expect(scanned).toEqual([[RECORD]]);
      expect(showAt(fixture.remote, INBOX, RECORD)).toContain("state: merged");
    },
    TIMEOUT,
  );

  test(
    "nothing merged pushes nothing",
    async () => {
      const { fixture, environment } = await submitted();
      const before = remoteLog(fixture, INBOX);

      const result = await settleLinked(environment, { tmpRoot: fixture.root });

      expect(result).toEqual({ recorded: [], warning: null });
      expect(remoteLog(fixture, INBOX)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "a delivery of an unlinked repository is never inspected",
    async () => {
      const { fixture, product, environment } = await submitted();
      product.squashMerge(BRANCH, "Acme login (#42)");
      const before = remoteLog(fixture, INBOX);

      const result = await settleLinked(
        { ...environment, checkoutOf: async () => null },
        { tmpRoot: fixture.root },
      );

      expect(result).toEqual({ recorded: [], warning: null });
      expect(remoteLog(fixture, INBOX)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "a refused push is a warning and records nothing",
    async () => {
      const { fixture, product, environment } = await submitted();
      product.squashMerge(BRANCH, "Acme login (#42)");
      fs.writeFileSync(
        path.join(fixture.remote, "hooks", "pre-receive"),
        `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/${INBOX}" ]; then\n    echo "GH006: Protected branch update failed for $ref." >&2\n    exit 1\n  fi\ndone\n`,
        { mode: 0o755 },
      );

      const result = await settleLinked(environment, { tmpRoot: fixture.root });

      expect(result.recorded).toEqual([]);
      expect(result.warning).toContain("recording merges on");
      expect(result.warning).toContain("GH006");
      expect(showAt(fixture.remote, INBOX, RECORD)).not.toContain("state: merged");
    },
    TIMEOUT,
  );
});

describe.skipIf(!REAL_OPENSPEC)("a publisher without the checkout", () => {
  test(
    "publishes from the merge another machine recorded, without a question",
    async () => {
      const { fixture, product, environment } = await submitted();
      product.squashMerge(BRANCH, "Acme login (#42)");
      expect((await settleLinked(environment, { tmpRoot: fixture.root })).recorded).toEqual([
        "acme-login",
      ]);

      const publisher = fixture.clone("acme-publisher");
      const result = await publishSubmitted(publisher, "acme-login", {
        runOpenSpec: fixture.runOpenSpec,
        tmpRoot: fixture.root,
      });

      expect(result).toMatchObject({ status: "ok", changes: ["acme-login"] });
    },
    TIMEOUT,
  );
});
