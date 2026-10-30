import { cloneAt, isDirectory, readGitLayout } from "./git-layout";

/**
 * The Checkout whose Claude wrap serves sessions in the Checkout at `root`
 * (design Decisions 1 and 12). Claude Code reads a linked worktree's hooks,
 * skills and MCP servers from its main worktree as well as from the worktree,
 * so a non-bare clone's main worktree serves its linked worktrees. On Windows,
 * in a bare clone's worktrees, in a main worktree and outside Git, the
 * Checkout serves itself. File reads only.
 */
export function servingClaudeWrapRoot(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return root;
  const layout = readGitLayout(root);
  if (layout?.kind !== "linked") return root;
  const main = cloneAt(layout.commonDir)?.mainWorktree;
  return main && isDirectory(main) ? main : root;
}
