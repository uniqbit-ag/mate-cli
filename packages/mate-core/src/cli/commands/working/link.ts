import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { FRAMEWORK_NAME } from "../../../framework";
import { writeRepoLocalRegistryEntry } from "../../../lib/orchestrator/repository-link";
import { extractRepoName } from "../artifact/extract-repo-name";

const execFileAsync = promisify(execFile);

export interface WorkingLinkDeps {
  cwd?: string;
  git?: (cwd: string, args: string[]) => Promise<string | null>;
  writeEntry?: typeof writeRepoLocalRegistryEntry;
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await execFileAsync("git", args, { cwd })).stdout.trim();
  } catch {
    return null;
  }
}

/**
 * `mate working link --companion <path> --yes`: the non-interactive Repository Link a
 * machine caller needs, such as a Workset container linking its worktree. It writes
 * the working repository's own, locally excluded link only, never the companion's
 * registry, so it cannot prune another machine's entries from a shared companion.
 */
export async function runWorkingLinkCommand(
  argv: string[],
  deps: WorkingLinkDeps = {},
): Promise<void> {
  const companionIndex = argv.indexOf("--companion");
  const companion = companionIndex === -1 ? undefined : argv[companionIndex + 1];
  const unknown = argv.filter(
    (arg, index) =>
      arg.startsWith("--") &&
      !["--companion", "--yes"].includes(arg) &&
      index !== companionIndex + 1,
  );
  if (!companion || !argv.includes("--yes") || unknown.length > 0) {
    console.error(
      `${FRAMEWORK_NAME} working link: usage: ${FRAMEWORK_NAME} working link --companion <path> --yes`,
    );
    process.exitCode = 1;
    return;
  }
  const companionPath = path.resolve(companion);
  try {
    await fs.access(path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"));
  } catch {
    console.error(`${FRAMEWORK_NAME} working link: ${companionPath} is not a Companion Repository`);
    process.exitCode = 1;
    return;
  }
  const git = deps.git ?? gitOutput;
  const cwd = deps.cwd ?? process.cwd();
  const repoRoot = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) {
    console.error(`${FRAMEWORK_NAME} working link: ${cwd} is not inside a Git working tree`);
    process.exitCode = 1;
    return;
  }
  const remote = await git(repoRoot, ["remote", "get-url", "origin"]);
  const id = (remote ? extractRepoName(remote) : null) ?? path.basename(repoRoot);
  await (deps.writeEntry ?? writeRepoLocalRegistryEntry)(
    repoRoot,
    companionPath,
    { id, path: repoRoot },
    "existing",
  );
  process.stdout.write(`linked ${repoRoot} to ${companionPath}\n`);
}
