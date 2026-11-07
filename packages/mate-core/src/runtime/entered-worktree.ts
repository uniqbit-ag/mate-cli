import path from "node:path";

import { checkoutRootOf, isDirectory, readGitLayout } from "./git-layout";

/** Claude Code's own worktrees, which RTK already leaves alone. */
const CLAUDE_WORKTREES = `${path.sep}${path.join(".claude", "worktrees")}${path.sep}`;

/**
 * True when a Claude session moved into a linked worktree, as `EnterWorktree` does:
 * `cwd` lies in a linked worktree outside `.claude/worktrees/`, and `projectDir`
 * (`CLAUDE_PROJECT_DIR`, the folder the session started in) lies in another
 * checkout or in none. False whenever either cannot be determined.
 */
export function movedIntoLinkedWorktree(cwd: string, projectDir: string | undefined): boolean {
  try {
    if (!cwd || !projectDir || !isDirectory(projectDir)) return false;
    const root = checkoutRootOf(cwd);
    if (!root || readGitLayout(root)?.kind !== "linked") return false;
    if (`${root}${path.sep}`.includes(CLAUDE_WORKTREES)) return false;
    return checkoutRootOf(projectDir) !== root;
  } catch {
    return false;
  }
}
