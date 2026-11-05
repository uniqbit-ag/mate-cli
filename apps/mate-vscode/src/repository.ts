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

export async function listWorktrees(repoRoot: string): Promise<Worktree[]> {
  const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  return parseWorktrees(stdout);
}
