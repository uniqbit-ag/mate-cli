import fs from "node:fs/promises";
import path from "node:path";

import type { Context } from "@opencode/plugin/promise/plugin";

type CompanionSkill = {
  id: string;
  name: string;
  description?: string;
  path: string;
  content: string;
};

function companionSkillPaths(companionPath: string): string[] {
  return [
    path.join(companionPath, ".agents", "skills"),
    path.join(companionPath, ".opencode", "skills"),
  ];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};

  const scalar = (key: string) => {
    const value = match[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
    return value?.replace(
      /^(?:"([\s\S]*)"|'([\s\S]*)')$/,
      (_all, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted,
    );
  };

  return { name: scalar("name"), description: scalar("description") };
}

async function findSkillFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name === "SKILL.md")
      .map((entry) => path.join(directory, entry.name));
    const nested = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => findSkillFiles(path.join(directory, entry.name))),
    );
    return [...files, ...nested.flat()];
  } catch {
    return [];
  }
}

function skillID(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "mate-skill"
  );
}

async function loadCompanionSkills(companionPath: string): Promise<CompanionSkill[]> {
  const files = (await Promise.all(companionSkillPaths(companionPath).map(findSkillFiles))).flat();
  const skills = await Promise.all(
    files.map(async (filePath): Promise<CompanionSkill | null> => {
      try {
        const content = await fs.readFile(filePath, "utf8");
        const metadata = parseFrontmatter(content);
        const name = metadata.name || path.basename(path.dirname(filePath));
        return {
          id: skillID(name),
          name,
          ...(metadata.description ? { description: metadata.description } : {}),
          path: filePath,
          content,
        };
      } catch {
        /** An unreadable companion skill must not prevent the session from loading. */
        return null;
      }
    }),
  );
  return skills.filter((skill) => skill !== null);
}

/**
 * Grants the session access to the companion and registers its skills. The
 * permission hook only widens access for companion resources; every other
 * evaluation keeps OpenCode's own verdict.
 */
export async function registerCompanionAccess(api: Context, companionPath: string): Promise<void> {
  const permissionRoot = path.resolve(companionPath);

  await api.permission.hook("evaluate", (event) => {
    if (event.resources.some((resource) => isWithin(permissionRoot, resource))) {
      event.effect = "allow";
      delete event.message;
    }
  });

  const skills = await loadCompanionSkills(permissionRoot);
  if (skills.length === 0) return;

  await api.skill.transform((editor) => {
    for (const skill of skills) {
      if (editor.get(skill.id)) {
        editor.update(skill.id, (current) => Object.assign(current, skill));
      } else {
        editor.add(skill as never);
      }
    }
  });
}
