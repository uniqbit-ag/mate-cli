import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class TrackedOutputError extends Error {}

export type StagedProjection = (stagingPath: string) => Promise<void>;

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new TrackedOutputError(
      `git ${args[0]} failed in ${cwd}: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`,
    );
  }
  return result.stdout;
}

function changedPaths(cwd: string): string[] {
  return git(cwd, ["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3));
}

/**
 * Reports what plugins would generate that is not already committed. The
 * projection runs against a disposable clone of the checkout's commit, so edits
 * in the live checkout neither matter nor are touched, and any file that
 * differs afterwards is drift. Nothing is written back to the live checkout.
 * Returns the drifting paths (empty when the commit is complete).
 */
export async function verifyTrackedPluginOutputs(
  companionPath: string,
  project: StagedProjection,
): Promise<string[]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-staging-"));
  try {
    const staged = path.join(root, "companion");
    git(root, ["clone", "--quiet", "--no-hardlinks", companionPath, staged]);
    await project(staged);
    return changedPaths(staged);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
