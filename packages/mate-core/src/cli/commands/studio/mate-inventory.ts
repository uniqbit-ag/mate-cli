import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

export interface StudioSkillInventory {
  claude: string[];
  opencode: string[];
  agents: string[];
}

const SKILL_DIRS = {
  claude: ".claude",
  opencode: ".opencode",
  agents: ".agents",
} as const;

async function skillNamesAt(companionPath: string, runtimeDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(path.join(companionPath, runtimeDir, "skills"), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

/**
 * Reports every skill directory in each Agent Runtime and the shared Agents tree.
 */
export async function collectSkillInventory(companionPath: string): Promise<StudioSkillInventory> {
  const [claude, opencode, agents] = await Promise.all([
    skillNamesAt(companionPath, SKILL_DIRS.claude),
    skillNamesAt(companionPath, SKILL_DIRS.opencode),
    skillNamesAt(companionPath, SKILL_DIRS.agents),
  ]);
  return { claude, opencode, agents };
}
