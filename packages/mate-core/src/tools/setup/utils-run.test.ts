import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type ChildLike = EventEmitter;

// Capture the real spawn as a plain value *before* mock.module() runs below.
// `import { spawn as realSpawn }` would instead create a live binding that
// re-reads the export slot on every reference — since mock.module() mutates
// that same slot in place, the binding would end up pointing at our own mock
// wrapper instead of the native implementation.
const realSpawn = childProcess.spawn;

let spawnImpl: (...args: unknown[]) => ChildLike;

mock.module("node:child_process", () => ({
  spawn: ((...args: unknown[]) => spawnImpl(...args)) as unknown as typeof childProcess.spawn,
}));

const { runCommand, runCommandSilently, runShellCommand } = await import("./utils");

beforeEach(() => {
  spawnImpl = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
});

afterEach(() => {
  mock.restore();
});

// bun's mock.module() replaces the "node:child_process" module for the rest
// of the test process — mock.restore() doesn't undo it. Fall back to the real
// spawn once this file's tests finish so later test files (which also import
// spawn from "node:child_process") aren't left calling into a stale spawnImpl.
afterAll(() => {
  spawnImpl = realSpawn as unknown as (...args: unknown[]) => ChildLike;
});

describe("command helpers", () => {
  test("runCommand rejects on non-zero exit codes", async () => {
    spawnImpl = (command, args, options) => {
      expect(command).toBe("uv");
      expect(args).toEqual(["sync"]);
      expect(options).toEqual({ cwd: "/tmp/project", stdio: "inherit" });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 2));
      return child;
    };

    await expect(runCommand("uv", ["sync"], { cwd: "/tmp/project" })).rejects.toThrow(
      "uv sync exited with code 2",
    );
  });

  test("runCommandSilently rejects on non-zero exit codes", async () => {
    spawnImpl = (_command, _args, options) => {
      expect(options).toEqual({ cwd: "/tmp/project", stdio: "pipe" });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 3));
      return child;
    };

    await expect(runCommandSilently("uv", ["sync"], { cwd: "/tmp/project" })).rejects.toThrow(
      "uv sync exited with code 3",
    );
  });

  test("runShellCommand rejects with the shell command in the message", async () => {
    spawnImpl = (command, options) => {
      expect(command).toBe("echo hello");
      expect(options).toEqual({ cwd: "/tmp/project", stdio: "inherit", shell: true });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 9));
      return child;
    };

    await expect(runShellCommand("echo hello", { cwd: "/tmp/project" })).rejects.toThrow(
      "Command failed: echo hello (exit 9)",
    );
  });
});
