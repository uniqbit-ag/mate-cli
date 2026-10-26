import fs from "node:fs/promises";
import path from "node:path";

import {
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

export function reconcileWorkingRepoClaudeSkillLinks(
  repoPath: string,
  companionPath: string | null,
  enabled: boolean,
  registeredCompanionPaths: string[] = [],
): Promise<"written" | "current"> {
  return reconcileClaudeLinks(SKILLS, repoPath, companionPath, enabled, registeredCompanionPaths);
}

export function removeWorkingRepoClaudeSkillLinks(
  repoPath: string,
  registeredCompanionPaths: string[] = [],
): Promise<"removed" | "absent"> {
  return removeClaudeLinks(SKILLS, repoPath, registeredCompanionPaths);
}
