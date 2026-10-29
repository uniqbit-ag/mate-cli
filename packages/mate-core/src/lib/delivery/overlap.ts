import fs from "node:fs/promises";
import path from "node:path";

import { ARCHIVE_DATE_PREFIX, changeNameOf, changesDirOf } from "./record";
import { readFrontmatter } from "../frontmatter";

export interface RequirementEdit {
  capability: string;
  requirement: string;
  operation: "MODIFIED" | "REMOVED";
}

export type DependencyWarning = { kind: "dependency"; change: string; message: string };

export type ArchiveWarning =
  | { kind: "overlap"; change: string; capability: string; requirement: string; message: string }
  | DependencyWarning;

const SECTION = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/;
const REQUIREMENT = /^###\s+Requirement:\s*(.+?)\s*$/;
const TASK = /^\s*[-*]\s+\[([ xX])\]/;

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
}

/** Requirements a change's delta specs MODIFY or REMOVE, by capability. */
export async function deltaRequirementEdits(changeDir: string): Promise<RequirementEdit[]> {
  const edits: RequirementEdit[] = [];
  for (const capability of await listDirectories(path.join(changeDir, "specs"))) {
    let source: string;
    try {
      source = await fs.readFile(path.join(changeDir, "specs", capability, "spec.md"), "utf8");
    } catch {
      continue;
    }
    let section: string | null = null;
    for (const line of source.split(/\r?\n/)) {
      const heading = SECTION.exec(line);
      if (heading) {
        section = heading[1];
        continue;
      }
      if (line.startsWith("## ")) section = null;
      const requirement = REQUIREMENT.exec(line);
      if (requirement && (section === "MODIFIED" || section === "REMOVED")) {
        edits.push({ capability, requirement: requirement[1], operation: section });
      }
    }
  }
  return edits;
}

/** Change names listed under `dependsOn` in any of the change's artifact frontmatter. */
export async function declaredDependencies(changeDir: string): Promise<string[]> {
  let files: string[];
  try {
    files = (await fs.readdir(changeDir)).filter((file) => file.endsWith(".md"));
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const file of files) {
    // A malformed header declares nothing; validation reports it elsewhere.
    const dependsOn = readFrontmatter(
      await fs.readFile(path.join(changeDir, file), "utf8"),
    )?.dependsOn;
    for (const name of Array.isArray(dependsOn) ? dependsOn : [dependsOn]) {
      if (typeof name === "string" && name.trim()) names.add(name.trim());
    }
  }
  return [...names].toSorted();
}

async function archivedChangeNames(changesDir: string): Promise<Set<string>> {
  return new Set(
    (await listDirectories(path.join(changesDir, "archive")))
      .filter((anchor) => ARCHIVE_DATE_PREFIX.test(anchor))
      .map(changeNameOf),
  );
}

/** True when the change's `tasks.md` has tasks and every one is checked. */
async function tasksComplete(changeDir: string): Promise<boolean> {
  let source: string;
  try {
    source = await fs.readFile(path.join(changeDir, "tasks.md"), "utf8");
  } catch {
    return false;
  }
  const marks = source.split(/\r?\n/).flatMap((line) => TASK.exec(line)?.[1] ?? []);
  return marks.length > 0 && marks.every((mark) => mark !== " ");
}

/**
 * Warnings shown before applying `change`: declared dependencies neither archived nor fully
 * implemented, so the change would be built without the code it builds on. Never blocks.
 */
export async function applyWarnings(
  companionPath: string,
  change: string,
): Promise<DependencyWarning[]> {
  const changesDir = changesDirOf(companionPath);
  const archived = await archivedChangeNames(changesDir);
  const warnings: DependencyWarning[] = [];
  for (const dependency of await declaredDependencies(path.join(changesDir, change))) {
    if (archived.has(dependency) || (await tasksComplete(path.join(changesDir, dependency)))) {
      continue;
    }
    warnings.push({
      kind: "dependency",
      change: dependency,
      message: `${change} depends on ${dependency}, which is not implemented yet; apply ${dependency} first.`,
    });
  }
  return warnings;
}

function requirementKey(edit: RequirementEdit): string {
  return JSON.stringify([edit.capability, edit.requirement]);
}

/**
 * Warnings shown before archiving `change`: another active change MODIFYing or REMOVing a
 * requirement this change also MODIFIES or REMOVES, and declared dependencies that are not
 * archived yet. Warnings inform; they never block archive.
 */
export async function archiveWarnings(
  companionPath: string,
  change: string,
): Promise<ArchiveWarning[]> {
  const changesDir = changesDirOf(companionPath);
  const warnings: ArchiveWarning[] = [];

  const own = await deltaRequirementEdits(path.join(changesDir, change));
  if (own.length > 0) {
    const ownKeys = new Set(own.map(requirementKey));
    for (const other of await listDirectories(changesDir)) {
      if (other === change || other === "archive") continue;
      for (const edit of await deltaRequirementEdits(path.join(changesDir, other))) {
        if (!ownKeys.has(requirementKey(edit))) continue;
        warnings.push({
          kind: "overlap",
          change: other,
          capability: edit.capability,
          requirement: edit.requirement,
          message: `${other} also changes ${edit.capability} › ${edit.requirement}; archiving ${other} later will replace this change's version of that requirement.`,
        });
      }
    }
  }

  const archived = await archivedChangeNames(changesDir);
  for (const dependency of await declaredDependencies(path.join(changesDir, change))) {
    if (archived.has(dependency)) continue;
    warnings.push({
      kind: "dependency",
      change: dependency,
      message: `${change} depends on ${dependency}, which is not archived yet; archive ${dependency} first.`,
    });
  }
  return warnings;
}
