import fs from "node:fs/promises";
import path from "node:path";

import { readProjectionFile } from "../../runtime/projection";
import { pruneEmptyAncestors } from "../../tools/setup/utils";

const CLAUDE_SKILLS_PATH = path.join(".claude", "skills");

async function skillNames(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillPath = path.join(root, entry.name, "SKILL.md");
    if (
      await fs
        .stat(skillPath)
        .then(() => true)
        .catch(() => false)
    )
      names.push(entry.name);
  }
  return names;
}

async function linkTarget(link: string): Promise<string | null> {
  const target = await fs.readlink(link).catch(() => null);
  return target === null ? null : path.resolve(path.dirname(link), target);
}

async function isManagedSkillLink(link: string, roots: string[]): Promise<boolean> {
  const target = await linkTarget(link);
  if (target === null) return false;
  return roots.some((root) => path.dirname(target) === root);
}

async function registeredSkillRoots(
  repoPath: string,
  companionPath: string | null,
  registeredCompanionPaths: string[],
): Promise<string[]> {
  const projection = readProjectionFile(repoPath);
  const candidates = [
    ...registeredCompanionPaths,
    companionPath ?? "",
    projection?.projection.companionPath ?? "",
  ];
  return [
    ...new Set(
      candidates.filter(Boolean).map((candidate) => path.resolve(candidate, CLAUDE_SKILLS_PATH)),
    ),
  ];
}

async function createSkillLink(target: string, link: string): Promise<void> {
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

export async function reconcileWorkingRepoClaudeSkillLinks(
  repoPath: string,
  companionPath: string | null,
  enabled: boolean,
  registeredCompanionPaths: string[] = [],
): Promise<"written" | "current"> {
  const currentRoot = companionPath ? path.resolve(companionPath, CLAUDE_SKILLS_PATH) : null;
  const roots = await registeredSkillRoots(repoPath, companionPath, registeredCompanionPaths);
  const targetRoot = path.join(path.resolve(repoPath), CLAUDE_SKILLS_PATH);
  const existing = await fs.readdir(targetRoot, { withFileTypes: true }).catch(() => []);
  const sourceNames: Set<string> =
    currentRoot && enabled ? new Set(await skillNames(currentRoot)) : new Set<string>();
  let changed = false;

  for (const entry of existing) {
    if (!entry.isSymbolicLink()) continue;
    const link = path.join(targetRoot, entry.name);
    if (!(await isManagedSkillLink(link, roots))) continue;

    const target = await linkTarget(link);
    if (
      currentRoot &&
      enabled &&
      target === path.join(currentRoot, entry.name) &&
      sourceNames.has(entry.name)
    ) {
      continue;
    }

    await fs.unlink(link);
    changed = true;
  }

  if (currentRoot && enabled && sourceNames.size > 0) {
    await fs.mkdir(targetRoot, { recursive: true });
    for (const name of sourceNames) {
      const link = path.join(targetRoot, name);
      const existingLink = await fs.lstat(link).catch(() => null);
      if (existingLink) continue;
      await createSkillLink(path.join(currentRoot, name), link);
      changed = true;
    }
  }

  if (changed || !enabled) {
    await pruneEmptyAncestors(targetRoot, path.resolve(repoPath));
  }
  return changed ? "written" : "current";
}

export async function removeWorkingRepoClaudeSkillLinks(
  repoPath: string,
  registeredCompanionPaths: string[] = [],
): Promise<"removed" | "absent"> {
  const result = await reconcileWorkingRepoClaudeSkillLinks(
    repoPath,
    null,
    false,
    registeredCompanionPaths,
  );
  return result === "written" ? "removed" : "absent";
}
