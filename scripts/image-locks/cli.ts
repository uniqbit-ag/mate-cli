#!/usr/bin/env bun
/**
 * Image lock drift entries over `lock-drift.ts`.
 *
 *   bun scripts/image-locks/cli.ts check [workspace-root]
 *     Read-only: fails when a global-tools lock no longer matches the release
 *     packages or its own pinned graph. Runs on every pull request.
 *
 *   bun scripts/image-locks/cli.ts refresh [workspace-root]
 *     Maintainer, before publication: refresh both locks from the local release
 *     packages, keeping every pin the dependency change does not explain.
 */
import path from "node:path";

import {
  checkImageLocks,
  defaultDeps,
  LockDriftError,
  refreshImageLocks,
  REFRESH_COMMAND,
  type Deps,
  type NpmRunner,
  type PinChange,
} from "./lock-drift";

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

const defaultIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const defaultRoot = path.resolve(import.meta.dirname, "..", "..");

export function check(
  workspaceRoot: string,
  deps: { runNpm: NpmRunner },
  io: Io = defaultIo,
): number {
  let results;
  try {
    results = checkImageLocks(workspaceRoot, deps);
  } catch (error) {
    if (!(error instanceof LockDriftError)) throw error;
    io.stderr(`image-locks: ${error.message}\n`);
    return 2;
  }

  const drifted = results.filter(({ problems }) => problems.length > 0);
  for (const { lock, problems } of drifted) {
    io.stderr(`${lock} is out of date:\n${problems.map((problem) => `  ${problem}`).join("\n")}\n`);
  }
  if (drifted.length > 0) {
    io.stderr(`\nRefresh the locks before publication: ${REFRESH_COMMAND}\n`);
    return 1;
  }
  io.stdout(
    `image-locks: ${results.map(({ lock }) => lock).join(", ")} match the release packages\n`,
  );
  return 0;
}

function describe(change: PinChange): string {
  if (change.kind === "added") return `  + ${change.path} ${change.version}`;
  if (change.kind === "removed") return `  - ${change.path} ${change.version}`;
  return `  ~ ${change.path} ${change.from} -> ${change.to}`;
}

export function refresh(workspaceRoot: string, deps: Deps, io: Io = defaultIo): number {
  let results;
  try {
    results = refreshImageLocks(workspaceRoot, deps);
  } catch (error) {
    if (!(error instanceof LockDriftError)) throw error;
    io.stderr(`image-locks: ${error.message}\n`);
    return 1;
  }

  for (const { lock, changes, changed } of results) {
    io.stdout(`${lock}: ${changed ? `${changes.length} pin change(s)` : "already current"}\n`);
    for (const change of changes) io.stdout(`${describe(change)}\n`);
  }
  if (results.some(({ changed }) => changed)) {
    io.stdout(
      [
        "",
        "Review the pin changes above before committing.",
        "Release-package pins (version, tarball and integrity) were kept: they still name the",
        "published package, whose dependencies may differ from the metadata now recorded.",
        "Release preparation replaces them when it pins the new release.",
        "",
      ].join("\n"),
    );
  }
  return 0;
}

if (import.meta.main) {
  const [command, workspaceArg] = process.argv.slice(2);
  const workspaceRoot = workspaceArg ? path.resolve(workspaceArg) : defaultRoot;
  const deps = defaultDeps(workspaceRoot);
  if (command === "check") process.exit(check(workspaceRoot, deps));
  if (command === "refresh") process.exit(refresh(workspaceRoot, deps));
  process.stderr.write("Usage: bun scripts/image-locks/cli.ts <check|refresh> [workspace-root]\n");
  process.exit(2);
}
