import fs from "node:fs";
import path from "node:path";

import { checkoutCommonDir, cloneAt, readGitLayout } from "../../runtime/git-layout";
import type { LinkedRepository } from "./types";

/**
 * The companion registry's rules for Checkouts (ADR-023): one entry per clone,
 * the clone's shared Git folder recorded on it, and a deleted Registered
 * Checkout handed over to another Checkout instead of dropped. File reads only,
 * no `git` process.
 */

function isDirectory(candidate: string): boolean {
  return fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function realPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

/**
 * The live Checkout a clone's entry moves to: the main worktree, else the
 * first live linked worktree by record name. A locked worktree whose folder is
 * away is never one.
 */
function handoverTarget(gitCommonDir: string | undefined): string | null {
  const clone = gitCommonDir ? cloneAt(gitCommonDir) : null;
  if (!clone) return null;
  if (clone.mainWorktree && isDirectory(clone.mainWorktree)) return clone.mainWorktree;
  return clone.linkedWorktrees.find((worktree) => worktree.live)?.path ?? null;
}

/**
 * The entry's Registered Checkout, read without writing: its folder while that
 * exists, else the Checkout a registry write would hand it over to.
 */
export function registeredCheckoutOf(entry: LinkedRepository): string | null {
  return isDirectory(entry.path) ? entry.path : handoverTarget(entry.gitCommonDir);
}

/** A hand-linked entry merged into its clone's kept entry. */
export interface MergedEntry {
  removed: LinkedRepository;
  kept: LinkedRepository;
}

export interface ReconciledRegistry {
  repos: LinkedRepository[];
  /** The entry the registered repository maps to. */
  kept: LinkedRepository;
  merged: MergedEntry[];
}

/** The clone's shared Git folder for an entry that names a live Checkout root. */
function cloneKey(entry: LinkedRepository): string | null {
  return checkoutCommonDir(entry.path);
}

/** Entries of one clone keep one: the main worktree's (one it already named first), else the first listed. */
function mergeClones(
  entries: LinkedRepository[],
  handedOver: ReadonlySet<LinkedRepository>,
): { repos: LinkedRepository[]; merged: MergedEntry[] } {
  const groups = new Map<string, LinkedRepository[]>();
  for (const entry of entries) {
    const key = cloneKey(entry);
    if (key) groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const merged: MergedEntry[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const main = cloneAt(key)?.mainWorktree ?? null;
    const atMain = group.filter((entry) => main !== null && realPath(entry.path) === main);
    const kept = atMain.find((entry) => !handedOver.has(entry)) ?? atMain[0] ?? group[0]!;
    for (const entry of group) if (entry !== kept) merged.push({ removed: entry, kept });
  }
  const removed = new Set(merged.map((entry) => entry.removed));
  return { repos: entries.filter((entry) => !removed.has(entry)), merged };
}

/** An entry naming a live Checkout gets its shared Git folder; one naming a non-Git folder records none. */
function withCommonDir(entry: LinkedRepository): LinkedRepository {
  const commonDir = cloneKey(entry);
  if (commonDir) return { ...entry, gitCommonDir: commonDir };
  const layout = readGitLayout(entry.path);
  if (layout && layout.kind !== "own") return entry;
  const { gitCommonDir: _dropped, ...rest } = entry;
  return rest;
}

/**
 * One registry write's rules, in order: hand over or drop dead entries, merge
 * entries of one clone, reuse the entry of `repository`'s clone or upsert by
 * ID, then fill each live entry's shared Git folder.
 */
export function reconcileRegistry(
  entries: readonly LinkedRepository[],
  repository: LinkedRepository,
): ReconciledRegistry {
  const handedOver = new Set<LinkedRepository>();
  const live = entries.flatMap((entry) => {
    if (isDirectory(entry.path)) return [entry];
    const target = handoverTarget(entry.gitCommonDir);
    if (!target) return [];
    const moved = { ...entry, path: target };
    handedOver.add(moved);
    return [moved];
  });

  const { repos, merged } = mergeClones(live, handedOver);
  const key = checkoutCommonDir(repository.path);
  let keptIndex = key ? repos.findIndex((entry) => cloneKey(entry) === key) : -1;
  if (keptIndex < 0) {
    const entry = { id: repository.id, path: repository.path };
    keptIndex = repos.findIndex((candidate) => candidate.id === repository.id);
    if (keptIndex >= 0) repos[keptIndex] = entry;
    else keptIndex = repos.push(entry) - 1;
  }

  const filled = repos.map(withCommonDir);
  const byOriginal = new Map(repos.map((entry, index) => [entry, filled[index]!]));
  return {
    repos: filled,
    kept: filled[keptIndex]!,
    merged: merged.map(({ removed, kept }) => ({ removed, kept: byOriginal.get(kept) ?? kept })),
  };
}

/**
 * The registry already lists `repository` as a write would leave it: for a Git
 * Checkout, exactly one entry of its clone, with its ID, a live path and the
 * clone's shared Git folder; otherwise its ID at its path.
 */
export function registryListsRepository(
  entries: readonly LinkedRepository[],
  repository: LinkedRepository,
): boolean {
  const key = checkoutCommonDir(repository.path);
  if (!key) {
    return entries.some((entry) => entry.id === repository.id && entry.path === repository.path);
  }
  const ofClone = entries.filter(
    (entry) => entry.gitCommonDir === key || (isDirectory(entry.path) && cloneKey(entry) === key),
  );
  const [only] = ofClone;
  return (
    ofClone.length === 1 &&
    only!.id === repository.id &&
    only!.gitCommonDir === key &&
    isDirectory(only!.path)
  );
}
