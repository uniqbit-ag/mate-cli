import fs from "node:fs";
import path from "node:path";

import { FRAMEWORK_NAME } from "./framework";

export const repoLocalDirName = () => `.${FRAMEWORK_NAME}`;

export function repoLocalDirPath(repoPath: string): string {
  return path.join(path.resolve(repoPath), repoLocalDirName());
}

export function repoLocalRegistryPath(repoPath: string): string {
  return path.join(repoLocalDirPath(repoPath), "config", "registry.yaml");
}

export function repoLocalFrameworkPath(repoPath: string): string {
  return path.join(repoLocalDirPath(repoPath), "config", "framework.yaml");
}

/**
 * Where the Companion Repository is reachable from inside the Working
 * Repository by ordinary path traversal. Spelled here rather than beside the
 * writer so a synchronous reader — a hook, a shell — names it without loading
 * the projection owner.
 */
export function companionLinkPath(repoPath: string): string {
  return path.join(repoLocalDirPath(repoPath), "companion");
}

/**
 * `cwd` and each of its ancestors, nearest first, ending at the filesystem
 * root. Shared by the async and sync registry walks so the two cannot land on
 * different ancestors.
 */
export function* ancestorDirectories(cwd: string): Generator<string> {
  let dir = path.resolve(cwd);
  for (;;) {
    yield dir;
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export interface RepoLocalRegistryFile {
  repoRoot: string;
  registryPath: string;
}

/**
 * Synchronous sibling of `findRepoLocalRegistryFile`. Differs only in I/O;
 * hooks and shells that cannot await resolve their Projection Root through it.
 */
export function findRepoLocalRegistryFileSync(cwd: string): RepoLocalRegistryFile | null {
  for (const dir of ancestorDirectories(cwd)) {
    const candidate = repoLocalRegistryPath(dir);
    try {
      if (fs.statSync(candidate).isFile()) return { repoRoot: dir, registryPath: candidate };
    } catch {
      // keep walking up
    }
  }
  return null;
}
