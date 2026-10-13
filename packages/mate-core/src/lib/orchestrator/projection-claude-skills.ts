import fs from "node:fs/promises";
import path from "node:path";

import { readProjectionFile } from "../../runtime/projection";
import { realLinkTarget, realOrResolved } from "../fs-utils";
import {
  links,
  readManifest,
  updateManifest,
  withLinks,
  type LinkRecord,
} from "../../runtime/runtime-document-manifest";
import { pruneEmptyAncestors } from "../../tools/setup/utils";

const CLAUDE_SKILLS_PATH = path.join(".claude", "skills");

/** The manifest key of a skill link: repo-relative, POSIX separators. */
function recordKey(name: string): string {
  return `.claude/skills/${name}`;
}

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
  return target === null ? null : realLinkTarget(link, target);
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
  const roots = await Promise.all(
    candidates
      .filter(Boolean)
      .map((candidate) => realOrResolved(path.resolve(candidate, CLAUDE_SKILLS_PATH))),
  );
  return [...new Set(roots)];
}

async function createSkillLink(target: string, link: string): Promise<void> {
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

/**
 * Recorded link: Mate's while it resolves to its recorded target. Unrecorded:
 * adopted only when it resolves into a registered, current or projected
 * companion. Records follow the filesystem, so a partial failure re-adopts.
 */
export async function reconcileWorkingRepoClaudeSkillLinks(
  repoPath: string,
  companionPath: string | null,
  enabled: boolean,
  registeredCompanionPaths: string[] = [],
): Promise<"written" | "current"> {
  const currentRoot = companionPath ? path.resolve(companionPath, CLAUDE_SKILLS_PATH) : null;
  const roots = await registeredSkillRoots(repoPath, companionPath, registeredCompanionPaths);
  const targetRoot = path.join(path.resolve(repoPath), CLAUDE_SKILLS_PATH);
  const recorded = links(await readManifest(repoPath), "claude");
  const existing = await fs.readdir(targetRoot, { withFileTypes: true }).catch(() => []);
  const sourceNames: Set<string> =
    currentRoot && enabled ? new Set(await skillNames(currentRoot)) : new Set<string>();
  const records: Record<string, LinkRecord> = {};
  let changed = false;

  for (const entry of existing) {
    if (!entry.isSymbolicLink()) continue;
    const link = path.join(targetRoot, entry.name);
    const target = await linkTarget(link);
    if (target === null) continue;
    const record = recorded[recordKey(entry.name)];
    const owned = record
      ? (await realOrResolved(record.target)) === target
      : roots.some((root) => path.dirname(target) === root);
    if (!owned) continue;

    const wanted = currentRoot ? path.join(currentRoot, entry.name) : null;
    if (wanted && sourceNames.has(entry.name) && (await realOrResolved(wanted)) === target) {
      records[recordKey(entry.name)] = { runtime: "claude", target: wanted };
      continue;
    }

    await fs.unlink(link);
    changed = true;
  }

  if (currentRoot && sourceNames.size > 0) {
    await fs.mkdir(targetRoot, { recursive: true });
    for (const name of sourceNames) {
      const link = path.join(targetRoot, name);
      const existingLink = await fs.lstat(link).catch(() => null);
      if (existingLink) continue;
      const target = path.join(currentRoot, name);
      await createSkillLink(target, link);
      records[recordKey(name)] = { runtime: "claude", target };
      changed = true;
    }
  }

  if (changed || !enabled) {
    await pruneEmptyAncestors(targetRoot, path.resolve(repoPath));
  }
  if (JSON.stringify(sortedEntries(records)) !== JSON.stringify(sortedEntries(recorded))) {
    await updateManifest(repoPath, (manifest) => withLinks(manifest, "claude", records));
    changed = true;
  }
  return changed ? "written" : "current";
}

function sortedEntries(records: Record<string, LinkRecord>): [string, LinkRecord][] {
  return Object.entries(records)
    .map(([key, record]): [string, LinkRecord] => [
      key,
      { runtime: record.runtime, target: record.target },
    ])
    .toSorted(([a], [b]) => a.localeCompare(b));
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
