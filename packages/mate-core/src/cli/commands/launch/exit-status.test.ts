import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { launchCommandDeps, runLaunchToolCommand } from "./shared";
import { LaunchPreflightError } from "../../../lib/orchestrator/types";

const originalCreateLauncher = launchCommandDeps.createLauncher;
const originalRunIndexCapCommand = launchCommandDeps.runIndexCapCommand;
const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;
const originalLog = console.log;

let printed: string[];
let stderr: string;
let originalStderrWrite: typeof process.stderr.write;
let originalStdoutWrite: typeof process.stdout.write;

function launcherReturning(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
}) {
  launchCommandDeps.createLauncher = () => ({
    prepare: async () => ({ execute: async () => result }),
  });
}

beforeEach(() => {
  printed = [];
  stderr = "";
  process.exitCode = 0;
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  console.log = (...args: unknown[]) => {
    printed.push(args.join(" "));
  };
  /** The launch result is emitted through `writeJsonStdout`, not `console.log`. */
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    printed.push(String(chunk).replace(/\n$/, ""));
    const callback = rest.find((argument) => typeof argument === "function");
    if (callback) (callback as (error?: Error | null) => void)(null);
    return true;
  }) as typeof process.stdout.write;
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  launchCommandDeps.runIndexCapCommand = async () => {};
});

afterEach(() => {
  console.log = originalLog;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  launchCommandDeps.createLauncher = originalCreateLauncher;
  launchCommandDeps.runIndexCapCommand = originalRunIndexCapCommand;
  process.stdin.isTTY = originalStdinIsTTY;
  process.stdout.isTTY = originalStdoutIsTTY;
  process.exitCode = 0;
});

describe("a launch reports the agent's outcome as its own exit status", () => {
  test("a non-zero agent exit produces a non-zero launch exit", async () => {
    launcherReturning({ exitCode: 7, stdout: "", stderr: "boom", signal: null });

    await runLaunchToolCommand("claude", []);

    expect(process.exitCode).toBe(7);
  });

  test("a zero agent exit still produces zero", async () => {
    launcherReturning({ exitCode: 0, stdout: "done", stderr: "", signal: null });

    await runLaunchToolCommand("claude", []);

    expect(process.exitCode).toBe(0);
  });

  test("the printed result does not stand in for the status", async () => {
    launcherReturning({ exitCode: 3, stdout: "partial", stderr: "", signal: null });

    await runLaunchToolCommand("claude", []);

    expect(printed.join("\n")).toContain('"exitCode": 3');
    expect(process.exitCode).toBe(3);
  });

  test("a signalled stop is distinguishable from an ordinary non-zero exit", async () => {
    launcherReturning({ exitCode: 143, stdout: "", stderr: "", signal: "SIGTERM" });

    await runLaunchToolCommand("claude", []);

    expect(process.exitCode).toBe(143);
    expect(printed.join("\n")).toContain('"signal": "SIGTERM"');
  });

  test("a preflight refusal keeps its guidance and a non-zero status", async () => {
    launchCommandDeps.createLauncher = () => ({
      prepare: async () => {
        throw new LaunchPreflightError("authentication failed");
      },
    });

    await runLaunchToolCommand("claude", []);

    expect(stderr).toContain("authentication failed");
    expect(process.exitCode).toBe(1);
    expect(printed).toEqual([]);
  });
});
