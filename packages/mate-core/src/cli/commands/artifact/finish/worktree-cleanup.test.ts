import { describe, expect, test } from "bun:test";

import type { GitRunner, PruneResult, PruneTarget } from "../../../../lib/workset/worktree";
import { cleanUpCompletedWorksets, type WorktreeCleanupDeps } from "./worktree-cleanup";

const ANCHOR = "2026-11-05-acme-login";
const COMMIT = "a".repeat(40);
const EMPTY: PruneResult = { removed: [], kept: [], warnings: [] };
const RECORD = "deliveries:\n  - repository: acme/web\n    branch: workset/acme-login\n";

function deps(calls: PruneTarget[], git: GitRunner): WorktreeCleanupDeps {
  return {
    readWorksets: async () => ({ worksets: [], problems: [] }),
    pruneWorktrees: async (_companion, targets) => {
      calls.push(...targets);
      return EMPTY;
    },
    git,
  };
}

describe("cleanUpCompletedWorksets", () => {
  test("reads the Delivery Record from the commit the publication landed in", async () => {
    const calls: PruneTarget[] = [];
    const shown: string[][] = [];
    const git: GitRunner = async (_cwd, args) => {
      shown.push(args);
      return { code: 0, stdout: RECORD, stderr: "" };
    };

    const outcomes = await cleanUpCompletedWorksets(
      "/acme/companion",
      [{ anchor: ANCHOR, commit: COMMIT }],
      deps(calls, git),
    );

    expect(shown).toEqual([["show", `${COMMIT}:openspec/changes/archive/${ANCHOR}/delivery.yaml`]]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: "acme-login", changes: [ANCHOR] });
    expect(calls[0]!.records?.get(ANCHOR)?.deliveries).toEqual([
      { repository: "acme/web", branch: "workset/acme-login" },
    ]);
    expect(outcomes.get(ANCHOR)).toEqual(EMPTY);
  });

  test("leaves the lookup to the checkout when the commit lacks the record", async () => {
    const calls: PruneTarget[] = [];
    const git: GitRunner = async () => ({ code: 128, stdout: "", stderr: "fatal: bad path" });

    await cleanUpCompletedWorksets(
      "/acme/companion",
      [{ anchor: ANCHOR, commit: COMMIT }],
      deps(calls, git),
    );

    expect(calls).toEqual([{ id: "acme-login", changes: [ANCHOR] }]);
  });

  test("leaves the lookup to the checkout when the record cannot be parsed", async () => {
    const calls: PruneTarget[] = [];
    const git: GitRunner = async () => ({ code: 0, stdout: "deliveries: 3\n", stderr: "" });

    await cleanUpCompletedWorksets(
      "/acme/companion",
      [{ anchor: ANCHOR, commit: COMMIT }],
      deps(calls, git),
    );

    expect(calls).toEqual([{ id: "acme-login", changes: [ANCHOR] }]);
  });

  test("reads no commit for a publication without one", async () => {
    const calls: PruneTarget[] = [];
    let ran = false;
    const git: GitRunner = async () => {
      ran = true;
      return { code: 0, stdout: RECORD, stderr: "" };
    };

    await cleanUpCompletedWorksets("/acme/companion", [{ anchor: ANCHOR }], deps(calls, git));

    expect(ran).toBe(false);
    expect(calls).toEqual([{ id: "acme-login", changes: [ANCHOR] }]);
  });
});
