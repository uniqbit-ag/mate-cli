import { accessSync, constants } from "node:fs";

import { isDirectory, mainWorktreeOf, readGitLayout } from "./git-layout";

/**
 * The other Checkout whose Claude wrap serves sessions in the Checkout at
 * `root` (design Decisions 1 and 12), or null when it serves itself. Claude
 * Code reads a linked worktree's hooks, skills and MCP servers from its main
 * worktree as well as from the worktree, so a non-bare clone's main worktree
 * serves its linked worktrees. On Windows, in a bare clone's worktrees, in a
 * main worktree, outside Git and where Mate cannot write the main worktree (a
 * factory Workset mounts only its `.git`), the Checkout serves itself. Reads
 * files and checks access only.
 */
export function otherServingClaudeWrapRoot(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "win32") return null;
  const layout = readGitLayout(root);
  if (layout?.kind !== "linked") return null;
  const main = mainWorktreeOf(layout.commonDir);
  return main && isDirectory(main) && isWritable(main) ? main : null;
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The Checkout whose Claude wrap serves the one at `root`: another, else `root` itself. */
export function servingClaudeWrapRoot(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return otherServingClaudeWrapRoot(root, platform) ?? root;
}
