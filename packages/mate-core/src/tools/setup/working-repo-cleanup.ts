import fs from "node:fs/promises";

import { repoLocalDirPath } from "../../lib/orchestrator/repo-local-registry";
import { cleanupWorkingRepoClaudeSettings } from "./providers/claude";
import { removeWorkingRepoLocalExcludes } from "./working-repo-local-state";

export interface WorkingRepoCleanupResult {
  changed: boolean;
  removed: string[];
  updated: string[];
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

export async function cleanupWorkingRepository(
  repoPath: string,
  registeredCompanionPaths: string[],
): Promise<WorkingRepoCleanupResult> {
  const updated: string[] = [];
  const removed: string[] = [];
  if (await cleanupWorkingRepoClaudeSettings(repoPath, registeredCompanionPaths)) {
    updated.push("claude-settings");
  }
  if (await removeWorkingRepoLocalExcludes(repoPath)) {
    removed.push("git-excludes");
  }
  const localDir = repoLocalDirPath(repoPath);
  if (await pathExists(localDir)) {
    await fs.rm(localDir, { recursive: true, force: true });
    removed.unshift(".mate");
  }
  return { changed: removed.length > 0 || updated.length > 0, removed, updated };
}
