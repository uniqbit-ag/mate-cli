import fs from "node:fs/promises";
import path from "node:path";

import { otherServingClaudeWrapRoot } from "../../runtime/serving-claude-wrap";
import {
  carriesClaudeLinks,
  holdsOnlyMateLinks,
  reconcileClaudeLinks,
  removeClaudeLinks,
  type ClaudeLinkRoot,
} from "./projection-claude-links";

/** A companion skill is a directory holding `SKILL.md`. */
const SKILLS: ClaudeLinkRoot = {
  dir: "skills",
  eligible: (entryPath) =>
    fs
      .stat(path.join(entryPath, "SKILL.md"))
      .then(() => true)
      .catch(() => false),
};

/**
 * A linked worktree served by the main worktree's Claude wrap reads the main
 * worktree's skills unless it has a `.claude/skills` of its own (design
 * Decision 13). While the main worktree carries the links and the worktree's
 * folder is missing or holds only Mate's links, a folder there would hide the
 * main worktree's skills, the operator's untracked ones included.
 */
async function servedByMainWorktree(
  repoPath: string,
  companionPath: string | null,
  registeredCompanionPaths: string[],
): Promise<boolean> {
  const serving = otherServingClaudeWrapRoot(repoPath);
  if (!serving) return false;
  return (
    (await carriesClaudeLinks(SKILLS, serving)) &&
    (await holdsOnlyMateLinks(SKILLS, repoPath, companionPath, registeredCompanionPaths))
  );
}

/** Places none, and withdraws earlier ones, where the main worktree serves them. */
export async function reconcileWorkingRepoClaudeSkillLinks(
  repoPath: string,
  companionPath: string | null,
  enabled: boolean,
  registeredCompanionPaths: string[] = [],
): Promise<"written" | "current"> {
  const placed =
    enabled && !(await servedByMainWorktree(repoPath, companionPath, registeredCompanionPaths));
  return reconcileClaudeLinks(SKILLS, repoPath, companionPath, placed, registeredCompanionPaths);
}

export function removeWorkingRepoClaudeSkillLinks(
  repoPath: string,
  registeredCompanionPaths: string[] = [],
): Promise<"removed" | "absent"> {
  return removeClaudeLinks(SKILLS, repoPath, registeredCompanionPaths);
}
