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

describe("an audience OpenCode launch", () => {
  const context = {
    repository: { id: "app", path: "/tmp/app" },
    launchWorkingDirectory: "/tmp/app",
    allowedAgents: ["opencode"],
    companionPath: "/tmp/companion",
    capabilities: [],
  };
  const layer = {
    audience: "ba",
    root: "/home/acme/.mate/state/audience-layers/k/ba/f",
    rendered: true,
  };

  function preparedWith(audienceLayer?: PrepareResult["audienceLayer"]): PrepareResult {
    return {
      ok: true,
      mode: "attended",
      runtime: "opencode",
      runtimes: ["opencode"],
      repositoryId: "app",
      companionPath: "/tmp/companion",
      steps: [],
      warnings: [],
      ...(audienceLayer ? { audienceLayer } : {}),
    };
  }

  async function launchEnv(args: string[], audienceLayer?: PrepareResult["audienceLayer"]) {
    const adapter = new OpenCodeAdapter(() => "2.0.0");
    const planned = await adapter.planLaunch(context, preparedWith(audienceLayer));
    return (await adapter.prepareLaunch(planned, args)).env;
  }

  test("hands the layer path to a launch that hosts its own server", async () => {
    for (const args of [[], ["run", "hello"]]) {
      const env = await launchEnv(args, layer);
      expect(JSON.parse(env.MATE_GUIDANCE_JSON ?? "{}").audienceLayer).toBe(layer.root);
    }
  });

  test("a service-bound subcommand gets a masked payload and no layer", async () => {
    const env = await launchEnv(["session", "list"], layer);
    expect(env.MATE_GUIDANCE_JSON).toBe("");
  });

  test("a launch without an audience carries no layer in its payload", async () => {
    const env = await launchEnv([]);
    expect(JSON.parse(env.MATE_GUIDANCE_JSON ?? "{}")).not.toHaveProperty("audienceLayer");
  });

  test("leaves the operator's OpenCode configuration variables alone", async () => {
    const names = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"] as const;
    const previous = names.map((name) => process.env[name]);
    process.env.OPENCODE_CONFIG = "/operator/opencode.json";
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_CONTENT;
    try {
      const env = await launchEnv([], layer);
      expect(env.OPENCODE_CONFIG).toBe("/operator/opencode.json");
      expect(env.OPENCODE_CONFIG_DIR).toBeUndefined();
      expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
  });
});
