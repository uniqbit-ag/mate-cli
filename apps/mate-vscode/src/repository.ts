import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseWorktrees, type Worktree } from "./worktrees";

const run = promisify(execFile);

/** Top level of the Git repository containing `folder`, or null outside one. */
export async function resolveRepository(folder: string | undefined): Promise<string | null> {
  if (!folder) return null;
  try {
    const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd: folder });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function listWorktrees(
  repoRoot: string,
  worksetBranches?: ReadonlySet<string>,
): Promise<Worktree[]> {
  const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  return parseWorktrees(stdout, worksetBranches);
}

/** `org/repository` from a Git remote URL (SSH or HTTPS), keeping nested groups. */
export function repositoryIdOf(remoteUrl: string): string | null {
  const trimmed = remoteUrl
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const scp = /^[^@/]+@[^:]+:(.+)$/.exec(trimmed);
  if (scp) return scp[1]!;
  try {
    const url = new URL(trimmed);
    return url.pathname.replace(/^\//, "") || null;
  } catch {
    return null;
  }
}

/** The `origin` remote's `org/repository`, or null without one. */
export async function repositoryId(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
    return repositoryIdOf(stdout);
  } catch {
    return null;
  }
}

/** `origin/HEAD`'s branch, else `main`. */
export async function defaultBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await run(
      "git",
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { cwd: repoRoot },
    );
    return stdout.trim().replace(/^origin\//, "") || "main";
  } catch {
    return "main";
  }
}
