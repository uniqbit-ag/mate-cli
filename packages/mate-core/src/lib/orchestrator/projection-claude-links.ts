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

/**
 * A `.claude/<dir>` folder whose companion entries Mate links one by one into
 * the Working Repository, e.g. `skills` or `commands`.
 */
export interface ClaudeLinkRoot {
  /** Folder name under `.claude/`. */
  dir: string;
  /** Whether a companion entry, given by absolute path, is linked. */
  eligible: (entryPath: string) => Promise<boolean>;
}

function rootPath(root: ClaudeLinkRoot): string {
  return path.join(".claude", root.dir);
}

/** The manifest key prefix of a root's links: repo-relative, POSIX separators. */
function keyPrefix(root: ClaudeLinkRoot): string {
  return `.claude/${root.dir}/`;
}

async function eligibleNames(sourceRoot: string, root: ClaudeLinkRoot): Promise<string[]> {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (await root.eligible(path.join(sourceRoot, entry.name))) names.push(entry.name);
  }
  return names;
}

async function linkTarget(link: string): Promise<string | null> {
  const target = await fs.readlink(link).catch(() => null);
  return target === null ? null : realLinkTarget(link, target);
}

async function registeredRoots(
  root: ClaudeLinkRoot,
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
      .map((candidate) => realOrResolved(path.resolve(candidate, rootPath(root)))),
  );
  return [...new Set(roots)];
}

async function createDirectoryLink(target: string, link: string): Promise<void> {
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

/**
 * Recorded link: Mate's while it resolves to its recorded target. Unrecorded:
 * adopted only when it resolves into a registered, current or projected
 * companion. Records follow the filesystem, so a partial failure re-adopts.
 * Only this root's records are read and replaced.
 */
export async function reconcileClaudeLinks(
  root: ClaudeLinkRoot,
  repoPath: string,
  companionPath: string | null,
  enabled: boolean,
  registeredCompanionPaths: string[] = [],
): Promise<"written" | "current"> {
  const scope = { prefix: keyPrefix(root) };
  const recordKey = (name: string): string => `${scope.prefix}${name}`;
  const currentRoot = companionPath ? path.resolve(companionPath, rootPath(root)) : null;
  const roots = await registeredRoots(root, repoPath, companionPath, registeredCompanionPaths);
  const targetRoot = path.join(path.resolve(repoPath), rootPath(root));
  const recorded = links(await readManifest(repoPath), "claude", scope);
  const existing = await fs.readdir(targetRoot, { withFileTypes: true }).catch(() => []);
  const sourceNames: Set<string> =
    currentRoot && enabled ? new Set(await eligibleNames(currentRoot, root)) : new Set<string>();
  const records: Record<string, LinkRecord> = {};
  let changed = false;

  for (const entry of existing) {
    if (!entry.isSymbolicLink()) continue;
    const link = path.join(targetRoot, entry.name);
    const target = await linkTarget(link);
    if (target === null) continue;
    if (!(await ownsLink(target, recorded[recordKey(entry.name)], roots))) continue;

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
      await createDirectoryLink(target, link);
      records[recordKey(name)] = { runtime: "claude", target };
      changed = true;
    }
  }

  if (changed || !enabled) {
    await pruneEmptyAncestors(targetRoot, path.resolve(repoPath));
  }
  if (JSON.stringify(sortedEntries(records)) !== JSON.stringify(sortedEntries(recorded))) {
    await updateManifest(repoPath, (manifest) => withLinks(manifest, "claude", records, scope));
    changed = true;
  }
  return changed ? "written" : "current";
}

/**
 * Mate owns a link it recorded with this target, or an unrecorded one that
 * resolves into one of `roots`.
 */
async function ownsLink(
  target: string,
  record: LinkRecord | undefined,
  roots: readonly string[],
): Promise<boolean> {
  return record
    ? (await realOrResolved(record.target)) === target
    : roots.some((candidate) => path.dirname(target) === candidate);
}

/** Mate has linked at least one entry of `root` in the Working Repository at `repoPath`. */
export async function carriesClaudeLinks(root: ClaudeLinkRoot, repoPath: string): Promise<boolean> {
  const manifest = await readManifest(repoPath).catch(() => null);
  return (
    manifest !== null &&
    Object.keys(links(manifest, "claude", { prefix: keyPrefix(root) })).length > 0
  );
}

/**
 * `root`'s folder in the Working Repository is missing or holds only Mate's
 * links: recorded ones, or ones resolving into a registered, current or
 * projected companion.
 */
export async function holdsOnlyMateLinks(
  root: ClaudeLinkRoot,
  repoPath: string,
  companionPath: string | null,
  registeredCompanionPaths: string[],
): Promise<boolean> {
  const targetRoot = path.join(path.resolve(repoPath), rootPath(root));
  const existing = await fs.readdir(targetRoot, { withFileTypes: true }).catch(() => []);
  if (existing.length === 0) return true;
  const roots = await registeredRoots(root, repoPath, companionPath, registeredCompanionPaths);
  const manifest = await readManifest(repoPath).catch(() => null);
  const recorded = manifest ? links(manifest, "claude", { prefix: keyPrefix(root) }) : {};
  const owned = await Promise.all(
    existing.map(async (entry) => {
      if (!entry.isSymbolicLink()) return false;
      const target = await linkTarget(path.join(targetRoot, entry.name));
      if (target === null) return false;
      return ownsLink(target, recorded[`${keyPrefix(root)}${entry.name}`], roots);
    }),
  );
  return owned.every(Boolean);
}

function sortedEntries(records: Record<string, LinkRecord>): [string, LinkRecord][] {
  return Object.entries(records)
    .map(([key, record]): [string, LinkRecord] => [
      key,
      { runtime: record.runtime, target: record.target },
    ])
    .toSorted(([a], [b]) => a.localeCompare(b));
}

export async function removeClaudeLinks(
  root: ClaudeLinkRoot,
  repoPath: string,
  registeredCompanionPaths: string[] = [],
): Promise<"removed" | "absent"> {
  const result = await reconcileClaudeLinks(root, repoPath, null, false, registeredCompanionPaths);
  return result === "written" ? "removed" : "absent";
}
