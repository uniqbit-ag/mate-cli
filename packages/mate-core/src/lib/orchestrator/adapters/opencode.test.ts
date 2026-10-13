import { describe, expect, test } from "bun:test";

import type { PrepareResult } from "../session-prepare";
import { LaunchPreflightError } from "../types";
import { OpenCodeAdapter } from "./opencode";

function failedPrepare(overrides: Partial<PrepareResult> = {}): PrepareResult {
  return {
    ok: false,
    mode: "attended",
    runtime: "opencode",
    runtimes: ["opencode"],
    repositoryId: "repo",
    companionPath: "/tmp/companion",
    steps: [
      { step: "working-target", outcome: "ok", detail: "current" },
      { step: "preflight", outcome: "failed", detail: "acme" },
      { step: "git-sync", outcome: "failed" },
    ],
    warnings: [],
    failure: new Error("acme"),
    ...overrides,
  };
}

describe("a failed OpenCode prepare", () => {
  test("in a Working Repository reads as one summary of every failed step", () => {
    const failure = new OpenCodeAdapter().launchFailure(failedPrepare());

    expect(failure).toBeInstanceOf(LaunchPreflightError);
    expect((failure as Error).message).toBe(
      ["mate: preparing repo for OpenCode failed.", "- preflight: acme", "- git-sync: failed"].join(
        "\n",
      ),
    );
  });

  test("without a repository raises the failed step's own error", () => {
    const own = new Error("acme");

    const failure = new OpenCodeAdapter().launchFailure(
      failedPrepare({ repositoryId: undefined, failure: own }),
    );

    expect(failure).toBe(own);
  });
});
