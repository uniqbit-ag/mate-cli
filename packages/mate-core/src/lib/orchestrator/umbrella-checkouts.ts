import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { gitEnvironment } from "../../runtime/companion-git";
import { readGitLayout } from "../../runtime/git-layout";
import { repoLocalRegistryPath } from "../../runtime/repo-local";
import { parseRemote, type ForgeRepo } from "../delivery/forge";

/**
 * Umbrella Repositories: a linked folder that is no Git checkout itself and whose
 * direct children are. Derived from the filesystem on every lookup; the registry
 * records nothing about it.
 */

const execFileAsync = promisify(execFile);

/** A checkout a registry entry stands for. */
export interface EntryCheckout {
  path: string;
  /** The `origin` URL as `readOrigin` returned it; null without one. */
  origin: string | null;
  /** The forge repository `origin` names; null without one or for another host form. */
  remote: ForgeRepo | null;
  /** The Umbrella Repository holding the checkout; absent for the entry itself. */
  umbrella?: string;
}

/** Reads a checkout's `origin` URL; null without one. */
export type OriginReader = (checkout: string) => Promise<string | null>;

/** Raw config, not `remote get-url`, so `insteadOf` rewrites do not change the identity. */
const rawOrigin: OriginReader = async (checkout) => {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], {
      cwd: checkout,
      env: gitEnvironment(),
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * The Umbrella Repository's children at `folder`, in name order: direct child folders
 * with a Git layout, an `origin` that names a forge repository, and no Repository
 * Link of their own (theirs wins). Empty when `folder` is a Git checkout, so it is no
 * umbrella.
 */
export async function umbrellaChildrenOf(
  folder: string,
  readOrigin: OriginReader = rawOrigin,
): Promise<EntryCheckout[]> {
  if (readGitLayout(folder)) return [];
  const listed = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
  const candidates = listed
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(folder, entry.name))
    .filter((child) => readGitLayout(child) !== null)
    .toSorted();
  const children = await mapBounded(candidates, async (child): Promise<EntryCheckout | null> => {
    if (await isFile(repoLocalRegistryPath(child))) return null;
    const origin = await readOrigin(child);
    const remote = origin ? parseRemote(origin) : null;
    return remote ? { path: child, origin, remote, umbrella: folder } : null;
  });
  return children.filter((child): child is EntryCheckout => child !== null);
}

/** Git subprocesses at once: a broad folder such as `~/src` may hold hundreds of clones. */
const ORIGIN_READS = 8;

/** `map` over `items` in order, at most `ORIGIN_READS` at a time. */
async function mapBounded<T, R>(items: readonly T[], map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++;
      // oxlint-disable-next-line no-await-in-loop -- each worker reads one child at a time
      results[at] = await map(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ORIGIN_READS, items.length) }, worker));
  return results;
}

/**
 * The checkouts a registry entry stands for: an Umbrella Repository's children, else
 * the entry's own folder, with its `origin` when it has one. `readChildOrigin` reads the
 * children, raw config by default so every caller gives a child the same identity.
 */
export async function linkedCheckoutsOf(
  entry: { path: string },
  readOrigin: OriginReader = rawOrigin,
  readChildOrigin: OriginReader = rawOrigin,
): Promise<EntryCheckout[]> {
  const children = await umbrellaChildrenOf(entry.path, readChildOrigin);
  if (children.length > 0) return children;
  const origin = await readOrigin(entry.path);
  return [{ path: entry.path, origin, remote: origin ? parseRemote(origin) : null }];
}
