import { describe, expect, test } from "bun:test";

import type { PrepareResult } from "../session-prepare";
import { LaunchPreflightError } from "../types";
import { OpenCodeAdapter } from "./opencode";
import { withEnv } from "../../../../../../test/fixtures";

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

describe("a background OpenCode launch", () => {
  const context = {
    repository: { id: "acme/app", path: "/tmp/app" },
    launchWorkingDirectory: "/tmp/app",
    allowedAgents: ["opencode"],
    companionPath: "/tmp/companion",
    capabilities: [],
  };

  function adapterWithServer(warning?: string) {
    const calls: Parameters<ConstructorParameters<typeof OpenCodeAdapter>[1] & {}>[0][] = [];
    const adapter = new OpenCodeAdapter(
      () => "2.1.4",
      async (input) => {
        calls.push(input);
        return {
          url: "http://127.0.0.1:4100",
          password: "secret",
          ...(warning ? { warning } : {}),
        };
      },
    );
    return { adapter, calls };
  }

  test("runs the TUI as a client of the server, without --bg or --standalone", async () => {
    const { adapter, calls } = adapterWithServer();
    const launch = await adapter.prepareLaunch(context, ["--bg", "--session", "ses_1"]);
    expect(launch.args).toEqual([
      "/tmp/app",
      "--session",
      "ses_1",
      "--server",
      "http://127.0.0.1:4100",
    ]);
    expect(launch.env.OPENCODE_PASSWORD).toBe("secret");
    expect(launch.env.MATE_GUIDANCE_JSON).toBe("");
    expect(calls).toHaveLength(1);
  });

  test("hands the guidance to the server only, keyed by repository", async () => {
    const { adapter, calls } = adapterWithServer();
    await adapter.prepareLaunch(context, ["--bg"]);
    const [server] = calls;
    expect(server?.repositoryId).toBe("acme/app");
    expect(server?.cwd).toBe("/tmp/app");
    expect(server?.version).toBe("2.1.4");
    expect(JSON.parse(server?.env.MATE_GUIDANCE_JSON ?? "{}").version).toBe(1);
    expect(server?.env.OPENCODE_PASSWORD).toBeUndefined();
  });

  test("keeps an editor's session origin out of the shared server", async () => {
    const { adapter, calls } = adapterWithServer();
    const launch = await withEnv("MATE_SESSION_ORIGIN", "editor", () =>
      adapter.prepareLaunch(context, ["--bg"]),
    );
    expect(calls[0]?.env.MATE_SESSION_ORIGIN).toBeUndefined();
    expect(launch.env.MATE_SESSION_ORIGIN).toBe("editor");
  });

  test("refuses a launch without a Working Repository", async () => {
    const { adapter } = adapterWithServer();
    const companion = {
      ...context,
      repository: undefined,
      launchWorkingDirectory: "/tmp/companion",
    };
    await expect(adapter.prepareLaunch(companion, ["--bg"])).rejects.toBeInstanceOf(
      LaunchPreflightError,
    );
  });

  test("leaves a launch without --bg alone", async () => {
    const { adapter, calls } = adapterWithServer();
    const launch = await adapter.prepareLaunch(context, []);
    expect(launch.args).toEqual(["/tmp/app", "--standalone"]);
    expect(calls).toHaveLength(0);
  });
});
