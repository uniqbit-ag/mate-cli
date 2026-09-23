#!/usr/bin/env bun
/**
 * Runs `bun test` with HOME pointed at a fresh temporary directory.
 *
 * HOME has to be set before Bun starts: Bun reads `os.homedir()` once, and a
 * child process spawned without an explicit `env` inherits the launch
 * environment rather than `process.env`, so assigning HOME from inside a test
 * process reaches neither. Everything after the script name is passed to
 * `bun test` unchanged.
 *
 *   bun ../../test/run-isolated.ts src/lib/update-checker.test.ts
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isolatedTestEnv } from "./isolated-home";

const realHome = os.homedir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "mate-test-home-"));
const cleanUp = () => fs.rmSync(home, { recursive: true, force: true });

const child = spawn(process.execPath, ["test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: isolatedTestEnv(process.env, home, realHome),
});

/** Forwarded rather than handled, so an interrupted run still removes its HOME on the way out. */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}

child.on("close", (code, signal) => {
  cleanUp();
  process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1));
});
