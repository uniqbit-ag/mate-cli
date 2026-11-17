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
 * Test files run in parallel workers; pass `--parallel=<n>` to override the
 * worker count (`--parallel=1` for a serial run).
 *
 *   bun ../../test/run-isolated.ts src/lib/update-checker.test.ts
 */
import { spawn, spawnSync } from "node:child_process";
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
const hasOption = (name: string) =>
  testArgs.some((arg) => arg === name || arg.startsWith(`${name}=`));
/** Capped: most suite time is spawned git, and timing-sensitive tests fail under heavier load. */
const maxWorkers = 8;
const parallel = [
  ...(hasOption("--parallel")
    ? []
    : [`--parallel=${Math.min(maxWorkers, os.availableParallelism())}`]),
  // Git-heavy tests outrun Bun's 5s default once workers compete for the disk.
  ...(hasOption("--timeout") ? [] : ["--timeout=20000"]),
];
/**
 * The Git that `/usr/bin/git` starts on macOS, or null where `git` is not that launcher. The
 * launcher looks the binary up on every call, which makes each spawn about 2.5 times slower.
 */
function launchedGit(): string | null {
  if (process.platform !== "darwin") return null;
  const first = (process.env.PATH ?? "")
    .split(path.delimiter)
    .find((dir) => dir && fs.existsSync(path.join(dir, "git")));
  if (first !== "/usr/bin") return null;
  const found = spawnSync("xcrun", ["-f", "git"], { encoding: "utf8" });
  const git = found.status === 0 ? found.stdout.trim() : "";
  return git && fs.existsSync(git) ? git : null;
}

const testHome = await createTempDir("mate-test-home-");
const temporary = [testHome];
const cleanUp = () => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
};
const env = isolatedTestEnv(process.env, testHome, realHome, { containers: suite !== "unit" });
const git = launchedGit();
if (git) {
  // A link, not Git's own folder: that one would put every other developer tool first too.
  const bin = await createTempDir("mate-test-git-");
  temporary.push(bin);
  fs.symlinkSync(git, path.join(bin, "git"));
  env.PATH = `${bin}${path.delimiter}${env.PATH ?? ""}`;
}
if (suite === "unit") {
  env.npm_config_offline = "true";
  env.npm_config_cache = path.join(testHome, ".cache", "npm");
  env.BUN_INSTALL_CACHE_DIR = path.join(testHome, ".cache", "bun");
}

const child = spawn(process.execPath, ["test", ...parallel, ...exclusions, ...testArgs], {
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
