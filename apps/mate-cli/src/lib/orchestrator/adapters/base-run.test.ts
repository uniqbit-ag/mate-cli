import { EventEmitter } from "node:events";
import type { spawn as SpawnFn } from "node:child_process";
import type { AdapterContext, PreparedLaunch } from "./base";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type SpawnResult = {
  child: EventEmitter & {
    stdout?: EventEmitter;
    stderr?: EventEmitter;
  };
  stdout?: EventEmitter;
  stderr?: EventEmitter;
};

let spawnImpl: (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => SpawnResult["child"];

mock.module("node:child_process", () => ({
  spawn: ((command: string, args: string[], options: Record<string, unknown>) =>
    spawnImpl(command, args, options)) as unknown as typeof SpawnFn,
}));

const { LaunchAdapter } = await import("./base");

function makeContext(): AdapterContext {
  return {
    repository: {
      id: "repo",
      path: "/tmp/repo",
      profile: "default",
    },
    policy: {
      allowedAgents: ["claude"],
    },
    companionPath: "/tmp/companion",
    capabilities: [],
  };
}

class TestAdapter extends LaunchAdapter {
  readonly toolName = "test-tool";

  buildArgs(_context: AdapterContext, args: string[]): string[] {
    return ["wrapped", ...args];
  }

  override extendEnvironment(): NodeJS.ProcessEnv {
    return { EXTRA_ENV: "1" };
  }
}

class PlainAdapter extends LaunchAdapter {
  readonly toolName = "plain-tool";

  buildArgs(_context: AdapterContext, args: string[]): string[] {
    return args;
  }
}

class InteractiveAdapter extends TestAdapter {
  override readonly interactive = true;
}

class WarningAdapter extends TestAdapter {
  override prepareLaunch(context: AdapterContext, args: string[]): PreparedLaunch {
    const launch = super.prepareLaunch(context, args);
    return { ...launch, warning: "warn now\n" };
  }
}

beforeEach(() => {
  spawnImpl = () => {
    const child = new EventEmitter() as SpawnResult["child"];
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout?.emit("data", Buffer.from("hello "));
      child.stderr?.emit("data", Buffer.from("warn "));
      child.stdout?.emit("data", Buffer.from("world"));
      child.stderr?.emit("data", Buffer.from("stderr"));
      child.emit("close", 0);
    });
    return child;
  };
});

afterEach(() => {
  mock.restore();
});

describe("LaunchAdapter runtime", () => {
  test("exposes the default environment and no-op validation hook", async () => {
    const adapter = new TestAdapter();
    const environment = adapter.environment(makeContext());
    const plainAdapter = new PlainAdapter();

    expect(environment).toMatchObject({
      MATE_NAME: "mate",
      MATE_VERSION: expect.any(String),
      MATE_ARTIFACT_PATH: "/tmp/companion",
      MATE_WRAPPER_BIN_PATH: expect.stringContaining("/apps/mate-cli/wrappers/bin"),
      MATE_GIT_AUTO_MODE: "0",
      MATE_REPO_ID: "repo",
      MATE_REPO_PATH: "/tmp/repo",
      MATE_REPO_PROFILE: "default",
      MATE_POLICY_JSON: JSON.stringify({ allowedAgents: ["claude"] }),
    });
    expect(adapter.extendEnvironment(makeContext())).toEqual({ EXTRA_ENV: "1" });
    expect(plainAdapter.extendEnvironment(makeContext())).toEqual({});
    await expect(adapter.validateLaunch(makeContext())).resolves.toBeUndefined();
  });

  test("captures stdout and stderr for non-interactive launches", async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> =
      [];
    spawnImpl = (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter() as SpawnResult["child"];
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout?.emit("data", Buffer.from("hello "));
        child.stderr?.emit("data", Buffer.from("warn "));
        child.stdout?.emit("data", Buffer.from("world"));
        child.emit("close", 0);
      });
      return child;
    };

    const result = await new TestAdapter().run(makeContext(), ["--flag"]);

    expect(result).toEqual({ exitCode: 0, stdout: "hello world", stderr: "warn " });
    expect(spawnCalls[0]).toMatchObject({
      command: "test-tool",
      args: ["wrapped", "--flag"],
      options: {
        cwd: "/tmp/repo",
        stdio: "pipe",
      },
    });
    expect((spawnCalls[0]?.options?.env as Record<string, string> | undefined)?.EXTRA_ENV).toBe(
      "1",
    );
  });

  test("writes warnings before spawning", async () => {
    const stderrWrite = mock(() => true);
    const originalWrite = process.stderr.write;
    process.stderr.write = stderrWrite as typeof process.stderr.write;

    try {
      await new WarningAdapter().run(makeContext(), []);
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(stderrWrite).toHaveBeenCalledWith("warn now\n");
  });

  test("uses inherited stdio for interactive launches and defaults missing exit codes to one", async () => {
    const spawnCalls: Array<Record<string, unknown>> = [];
    spawnImpl = (_command, _args, options) => {
      spawnCalls.push(options);
      const child = new EventEmitter() as SpawnResult["child"];
      queueMicrotask(() => {
        child.emit("close", undefined);
      });
      return child;
    };

    const result = await new InteractiveAdapter().run(makeContext(), ["--chat"]);

    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "" });
    expect(spawnCalls[0]?.stdio).toBe("inherit");
  });

  test("rejects when the spawned process emits an error", async () => {
    spawnImpl = () => {
      const child = new EventEmitter() as SpawnResult["child"];
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.emit("error", new Error("spawn failed"));
      });
      return child;
    };

    await expect(new TestAdapter().run(makeContext(), [])).rejects.toThrow("spawn failed");
  });
});
