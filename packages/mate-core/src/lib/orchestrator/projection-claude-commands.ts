import fs from "node:fs/promises";

import {
  reconcileClaudeLinks,
  removeClaudeLinks,
  type ClaudeLinkRoot,
} from "./projection-claude-links";

/**
 * A companion command directory (e.g. `acme/`) holds at least one
 * `.md` file. Loose command files are not linked: a file symlink needs
 * elevation on Windows, a directory junction does not.
 */
const COMMANDS: ClaudeLinkRoot = {
  dir: "commands",
  eligible: async (entryPath) => {
    const entries = await fs.readdir(entryPath).catch(() => []);
    return entries.some((name) => name.endsWith(".md"));
  },
};

export function reconcileWorkingRepoClaudeCommandLinks(
  repoPath: string,
  companionPath: string | null,
  enabled: boolean,
  registeredCompanionPaths: string[] = [],
): Promise<"written" | "current"> {
  return reconcileClaudeLinks(COMMANDS, repoPath, companionPath, enabled, registeredCompanionPaths);
}

export function removeWorkingRepoClaudeCommandLinks(
  repoPath: string,
  registeredCompanionPaths: string[] = [],
): Promise<"removed" | "absent"> {
  return removeClaudeLinks(COMMANDS, repoPath, registeredCompanionPaths);
}
