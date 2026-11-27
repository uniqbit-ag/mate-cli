import { describe, expect, test } from "bun:test";

import { renderOutcome, sharedRefusalMessage } from "./output";

const base = { repository: "acme/acme-app", branch: "change/x", result: "unknown" as const };

describe("renderOutcome", () => {
  test("a settled outcome prints nothing", () => {
    expect(renderOutcome({ ...base, result: "merged", needsAnswer: false })).toEqual([]);
  });

  test("a squash suggestion names the commit and asks for confirmation", () => {
    expect(
      renderOutcome({
        ...base,
        needsAnswer: true,
        answerReason: "likely-merged",
        suggestion: { commit: "abcdef1234567890", style: "squash" },
      }),
    ).toEqual(["  change/x: likely merged (squash, abcdef123456); needs your confirmation"]);
  });

  test("not on the default branch names the last fetch", () => {
    expect(
      renderOutcome({
        ...base,
        needsAnswer: true,
        answerReason: "not-on-default",
        fetchedAt: "2026-11-01T00:00:00.000Z",
      }),
    ).toEqual([
      "  change/x: not on the default branch (last fetch 2026-11-01T00:00:00.000Z); needs an answer",
    ]);
    expect(
      renderOutcome({
        ...base,
        needsAnswer: true,
        answerReason: "not-on-default",
        fetchedAt: null,
      }),
    ).toEqual(["  change/x: not on the default branch (never fetched); needs an answer"]);
  });

  test("a deleted branch this machine holds no commits of says Git cannot check it", () => {
    expect(
      renderOutcome({
        ...base,
        needsAnswer: true,
        answerReason: "not-on-default",
        fetch: { ok: true, branchDeleted: true },
      }),
    ).toEqual([
      "  change/x: deleted on the remote and its commits are not on this machine, so Git cannot check it; needs an answer",
    ]);
  });

  test("a deleted branch asks to drop; a missing checkout names the repository", () => {
    expect(renderOutcome({ ...base, needsAnswer: true, answerReason: "branch-deleted" })).toEqual([
      "  change/x: deleted on the remote and not on the default branch; merged, or drop it?",
    ]);
    expect(renderOutcome({ ...base, needsAnswer: true, answerReason: "no-checkout" })).toEqual([
      "  change/x: acme/acme-app is not linked on this machine; needs an answer",
    ]);
  });

  test("a failed fetch is reported even when local refs settled the branch", () => {
    expect(
      renderOutcome({
        ...base,
        result: "merged",
        needsAnswer: false,
        fetch: { ok: false, message: "git fetch timed out" },
      }),
    ).toEqual(["  change/x: git fetch timed out; local refs used"]);
  });
});

describe("sharedRefusalMessage", () => {
  test("an empty delivery branch says to commit on it or record not applicable", () => {
    const message = sharedRefusalMessage({
      reason: "empty-delivery-branch",
      change: "acme",
      repository: "acme/acme-app",
      branch: "workset/acme",
    });
    expect(message).toContain("Commit the work on workset/acme first");
    expect(message).toContain("--not-applicable");
  });
});
