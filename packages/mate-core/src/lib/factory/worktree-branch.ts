import type { CommandResult } from "./command";
import { FactoryError } from "./ids";

/** Reads actual delivery ownership; detached or unreadable HEAD must not become a default. */
export async function readWorktreeBranch(
  worktree: string,
  git: (args: string[]) => Promise<CommandResult>,
): Promise<string> {
  const result = await git(["-C", worktree, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = result.stdout.trim();
  if (result.status !== 0 || !branch) {
    throw new FactoryError(
      `Worktree ${worktree} has detached or unreadable HEAD; select a delivery branch explicitly before continuing.`,
    );
  }
  return branch;
}
