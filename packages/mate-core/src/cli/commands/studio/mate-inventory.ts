import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { MATE_SKILLS } from "../../../tools/setup/mate";

/** Skill trees Mate can own in an Agent Runtime. Directory names alone do not establish provenance. */
const MATE_MANAGED_SKILLS = new Set<string>([...MATE_SKILLS, "react-doctor"]);
const RUNTIME_DIRS = [".claude", ".opencode"] as const;

/**
 * Reports only names from Mate's explicit ownership inventory. This excludes
 * lock-file entries and hand-authored trees without inspecting their content.
 */
export async function collectMateSkillNames(companionPath: string): Promise<string[]> {
  const installed = new Set<string>();

  await Promise.all(
    RUNTIME_DIRS.map(async (runtimeDir) => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(path.join(companionPath, runtimeDir, "skills"), {
          withFileTypes: true,
        });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.isDirectory() && MATE_MANAGED_SKILLS.has(entry.name)) {
          installed.add(entry.name);
        }
      }
    }),
  );

  return [...installed].toSorted();
}
