import { describe, expect, test } from "bun:test";

import { renderOutcome } from "./output";

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
