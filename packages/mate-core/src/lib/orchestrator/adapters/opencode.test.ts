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

describe("the OpenCode guidance payload", () => {
  const context = {
    repository: { id: "app", path: "/tmp/app" },
    launchWorkingDirectory: "/tmp/app",
    allowedAgents: ["opencode"],
    companionPath: "/tmp/companion",
    capabilities: [],
  };

  async function launchedPayload(args: string[]): Promise<string | undefined> {
    const previous = process.env.MATE_GUIDANCE_JSON;
    process.env.MATE_GUIDANCE_JSON = '{"stale":true}';
    try {
      const launch = await new OpenCodeAdapter(() => "2.0.0").prepareLaunch(context, args);
      return launch.env.MATE_GUIDANCE_JSON;
    } finally {
      if (previous === undefined) delete process.env.MATE_GUIDANCE_JSON;
      else process.env.MATE_GUIDANCE_JSON = previous;
    }
  }

  test("is injected into the TUI and `run`, which host their own server", async () => {
    for (const args of [[], ["--model", "x"], ["run", "hello"], ["--standalone"]]) {
      const payload = await launchedPayload(args);
      expect(JSON.parse(payload ?? "{}").version).toBe(1);
    }
  });

  test("is masked for a service-bound subcommand", async () => {
    expect(await launchedPayload(["session", "list"])).toBe("");
  });

  test("is masked for an operator-chosen server", async () => {
    expect(await launchedPayload(["--server", "http://127.0.0.1:4096"])).toBe("");
    expect(await launchedPayload(["run", "--server=http://127.0.0.1:4096", "hi"])).toBe("");
  });
});
