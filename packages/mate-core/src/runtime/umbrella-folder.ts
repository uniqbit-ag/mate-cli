import fs from "node:fs";
import path from "node:path";

import { parseRemote, repositoryPath } from "./forge-remote";
import { originUrlOf, readGitLayout, type GitLayout } from "./git-layout";
import { mirroredUmbrellaOf, repoLocalRegistryPath } from "./repo-local";

export { mirroredUmbrellaOf } from "./repo-local";

/**
 * Umbrella folders from files alone: synchronous, no `git` process, so hooks and the
 * OpenCode plugin can ask. `lib/orchestrator/umbrella-checkouts` re-exports these.
 */

/** Direct child folders of `folder` with a Git layout and no Repository Link of their own, in name order. */
export function umbrellaChildFolders(folder: string): string[] {
  return childCheckouts(folder).map((child) => child.path);
}

function childCheckouts(folder: string): { path: string; layout: GitLayout }[] {
  let listed: fs.Dirent[];
  try {
    listed = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return listed
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(folder, entry.name))
    .toSorted()
    .flatMap((child) => {
      const layout = readGitLayout(child);
      return layout && !isFile(repoLocalRegistryPath(child)) ? [{ path: child, layout }] : [];
    });
}

/** An umbrella child named by its forge identity. */
export interface UmbrellaChild {
  path: string;
  /** `org/repository`, from the raw `remote.origin.url`. */
  repository: string;
}

/**
 * `umbrellaChildrenOf` from files alone: each child folder whose `origin` names a forge
 * repository, in name order. Does not follow config `include`s. Empty for a Git checkout.
 */
export function umbrellaChildIdentities(folder: string): UmbrellaChild[] {
  if (readGitLayout(folder)) return [];
  return childCheckouts(folder).flatMap((child) => {
    const origin = originUrlOf(child.layout);
    const remote = origin ? parseRemote(origin) : null;
    return remote ? [{ path: child.path, repository: repositoryPath(remote) }] : [];
  });
}

function isFile(candidate: string): boolean {
  return fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() ?? false;
}

/**
 * The linked Umbrella Repository or mirrored umbrella worktree holding `dir`: the nearest
 * ancestor-or-self with a Repository Link, no Git layout, and a direct child Git checkout.
 * Null inside a Git checkout, even one in an umbrella, and when the nearest link is no
 * umbrella's.
 */
export function umbrellaFolderOf(dir: string): string | null {
  let current = path.resolve(dir);
  for (;;) {
    if (readGitLayout(current)) return null;
    if (isFile(repoLocalRegistryPath(current))) {
      return umbrellaChildFolders(current).length > 0 ? current : null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The Umbrella Repository whose mirrored worktree the umbrella folder `folder` is; else null. */
export function umbrellaMirroredBy(folder: string): string | null {
  const umbrella = mirroredUmbrellaOf(folder);
  return umbrella && umbrellaFolderOf(umbrella) === umbrella ? umbrella : null;
}
