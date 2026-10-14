// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import { CURRENT_LAYER_LINK } from "../../runtime/audience-layer";
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

const CLAUDE_AGENTS_PATH = path.join(".claude", "agents");

/** The manifest key of an agent link: repo-relative, POSIX separators. */
function agentKey(file: string): string {
  return `.claude/agents/${file}`;
}

async function agentFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
    .map((entry) => entry.name);
}

/**
 * Every link the wrap wants, by manifest key: the companion's skills, then the
 * wrapped audience's skills and agents. An audience link targets the layer
 * through its `current` link, so a re-rendered layer never strands it. A
 * companion skill wins a name both provide.
 */
async function wantedLinks(
  currentRoot: string | null,
  layerRoot: string | null,
): Promise<Map<string, string>> {
  const wanted = new Map<string, string>();
  if (currentRoot) {
    for (const name of await skillNames(currentRoot)) {
      wanted.set(recordKey(name), path.join(currentRoot, name));
    }
  }
  if (layerRoot) {
    const layerSkills = path.join(layerRoot, "skills");
    for (const name of await skillNames(layerSkills)) {
      if (!wanted.has(recordKey(name))) wanted.set(recordKey(name), path.join(layerSkills, name));
    }
    const layerAgents = path.join(layerRoot, "agents");
    for (const file of await agentFiles(layerAgents)) {
      wanted.set(agentKey(file), path.join(layerAgents, file));
    }
  }
  return wanted;
}

/**
 * Recorded link: Mate's while it resolves to its recorded target. Unrecorded:
 * a skill link is adopted only when it resolves into a registered, current or
 * projected companion; an agent link never is. Records follow the filesystem,
 * so a partial failure re-adopts.
 */
export async function reconcileWorkingRepoClaudeSkillLinks(
  repoPath: string,
  companionPath: string | null,
  enabled: boolean,
  registeredCompanionPaths: string[] = [],
  audienceLayerDir: string | null = null,
): Promise<"written" | "current"> {
  const repoRoot = path.resolve(repoPath);
  const currentRoot = companionPath ? path.resolve(companionPath, CLAUDE_SKILLS_PATH) : null;
  const layerRoot =
    audienceLayerDir && enabled ? path.join(audienceLayerDir, CURRENT_LAYER_LINK, ".claude") : null;
  const roots = await registeredSkillRoots(repoPath, companionPath, registeredCompanionPaths);
  const recorded = links(await readManifest(repoPath), "claude");
  const wanted = await wantedLinks(enabled ? currentRoot : null, layerRoot);
  const records: Record<string, LinkRecord> = {};
  let changed = false;

  const linkDirs = [
    { dir: path.join(repoRoot, CLAUDE_SKILLS_PATH), keyOf: recordKey, adoptable: true },
    { dir: path.join(repoRoot, CLAUDE_AGENTS_PATH), keyOf: agentKey, adoptable: false },
  ];
  for (const { dir, keyOf, adoptable } of linkDirs) {
    const existing = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of existing) {
      if (!entry.isSymbolicLink()) continue;
      const link = path.join(dir, entry.name);
      const target = await linkTarget(link);
      if (target === null) continue;
      const key = keyOf(entry.name);
      const record = recorded[key];
      const owned = record
        ? (await realOrResolved(record.target)) === target
        : adoptable && roots.some((root) => path.dirname(target) === root);
      if (!owned) continue;

      const want = wanted.get(key);
      if (want && (await realOrResolved(want)) === target) {
        records[key] = { runtime: "claude", target: want };
        continue;
      }

      await fs.unlink(link);
      changed = true;
    }
  }

  for (const [key, target] of wanted) {
    const link = path.join(repoRoot, ...key.split("/"));
    const existingLink = await fs.lstat(link).catch(() => null);
    if (existingLink) continue;
    await fs.mkdir(path.dirname(link), { recursive: true });
    if (key.startsWith(".claude/agents/")) await fs.symlink(target, link, "file");
    else await createSkillLink(target, link);
    records[key] = { runtime: "claude", target };
    changed = true;
  }

  if (changed || !enabled) {
    for (const { dir } of linkDirs) await pruneEmptyAncestors(dir, repoRoot);
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
