#!/usr/bin/env bun
/**
 * Runs `bun test` with HOME pointed at a fresh temporary directory.
 *
 * HOME has to be set before Bun starts: Bun reads `os.homedir()` once, and a
 * child process spawned without an explicit `env` inherits the launch
 * environment rather than `process.env`, so assigning HOME from inside a test
 * process reaches neither. Everything after the script name except
 * `--suite=` is passed to `bun test` unchanged.
 *
 *   bun ../../test/run-isolated.ts src/lib/update-checker.test.ts
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTempDir } from "./fixtures";
import { isolatedTestEnv } from "./isolated-home";
import { suiteArguments } from "./suites";

const realHome = os.homedir();
const args = process.argv.slice(2);
const isSuiteOption = (arg: string) => arg.startsWith("--suite=");
const suiteOptions = args.filter(isSuiteOption);
const testArgs = args.filter((arg) => !isSuiteOption(arg));
const suite = suiteOptions[0]?.slice("--suite=".length);
if (
  suiteOptions.length > 1 ||
  (suite !== undefined && suite !== "unit" && suite !== "integration")
) {
  throw new Error(
    "Use one --suite=unit or --suite=integration option, or omit it for the full suite.",
  );
}
const exclusions = suite ? suiteArguments(suite) : [];
const testHome = await createTempDir("mate-test-home-");
const cleanUp = () => fs.rmSync(testHome, { recursive: true, force: true });
const env = isolatedTestEnv(process.env, testHome, realHome, { containers: suite !== "unit" });
if (suite === "unit") {
  env.npm_config_offline = "true";
  env.npm_config_cache = path.join(testHome, ".cache", "npm");
  env.BUN_INSTALL_CACHE_DIR = path.join(testHome, ".cache", "bun");
}

const child = spawn(process.execPath, ["test", ...exclusions, ...testArgs], {
  stdio: "inherit",
  env,
});

/** Forwarded rather than handled, so an interrupted run still removes its HOME on the way out. */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  cleanUp();
  console.error(error.message);
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  cleanUp();
  process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1));
});
