import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import {
  ancestorDirectories,
  repoLocalDirName,
  repoLocalRegistryPath,
  type RepoLocalRegistryFile,
} from "../../runtime/repo-local";
import { firstFailure } from "./projection-types";
import { normalizeLinkedRepository } from "./repo-local-store";
import { project } from "./working-repo-projection";
import type { RepoLocalRegistry } from "./repo-local-store";
import type { CompanionSource, LinkedRepository } from "./types";

export {
  repoLocalDirPath,
  repoLocalFrameworkPath,
  repoLocalRegistryPath,
} from "../../runtime/repo-local";
export { pathIsDirectory } from "../fs-utils";
export {
  RepoLocalRegistryStore,
  upsertRepoLocalCompanionPointer,
  upsertRepoLocalLinkedRepository,
  writeRepoLocalFrameworkConfig,
  type RepoLocalCompanionPointer,
  type RepoLocalRegistry,
} from "./repo-local-store";

const repoLocalScanSkipDirNames = () =>
  new Set([
    ".git",
    repoLocalDirName(),
    "node_modules",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".venv",
    "venv",
    "target",
    ".cache",
  ]);

/**
 * Records a Repository Link. Deliberately writes no projection file: wrapping is
 * an explicit act, which is why the scope and not the inputs picks the entries.
 * Throws on the first failed entry — this caller's own callers warn on it, so
 * the owner's per-entry best-effort report must not silently become success.
 */
export async function writeRepoLocalRegistryEntry(
  repoPath: string,
  companionPath: string,
  repository: LinkedRepository,
  source: CompanionSource,
): Promise<void> {
  const { outcomes } = await project("link", { repoPath, companionPath, repository, source });
  const failure = firstFailure(outcomes);
  if (failure) throw failure.error ?? new Error(`failed to project ${failure.path}`);
}

export async function findRepoLocalLinkedRepository(cwd: string): Promise<LinkedRepository | null> {
  const found = await findRepoLocalRegistryFile(cwd);
  if (!found) return null;

  try {
    const raw = await fs.readFile(found.registryPath, "utf8");
    const parsed = parse(raw) as Partial<RepoLocalRegistry> | null;
    if (!parsed?.repository) return null;
    return normalizeLinkedRepository(parsed.repository);
  } catch {
    return null;
  }
}

/** Returns other companion paths this repo is locally linked to, excluding `excludePath`. */
export async function listOtherRepoLocalCompanionPaths(
  repoPath: string,
  excludePath: string,
): Promise<string[]> {
  const resolvedExclude = path.resolve(excludePath);
  try {
    const raw = await fs.readFile(repoLocalRegistryPath(repoPath), "utf8");
    const parsed = parse(raw) as Partial<RepoLocalRegistry> | null;
    if (!parsed || !Array.isArray(parsed.companions)) return [];
    const paths: string[] = [];
    for (const pointer of parsed.companions) {
      const resolvedPath = path.resolve(pointer.path);
      if (resolvedPath !== resolvedExclude) paths.push(resolvedPath);
    }
    return paths;
  } catch {
    return [];
  }
}

/** Walks up from `cwd` looking for the nearest ancestor holding a repo-local registry file. */
export async function findRepoLocalRegistryFile(
  cwd: string,
): Promise<RepoLocalRegistryFile | null> {
  for (const dir of ancestorDirectories(cwd)) {
    const candidate = repoLocalRegistryPath(dir);
    try {
      if ((await fs.stat(candidate)).isFile()) return { repoRoot: dir, registryPath: candidate };
    } catch {
      // keep walking up
    }
  }
  return null;
}

/** Finds repo-local registries strictly beneath `rootPath`, skipping noisy directories. */
export async function findDescendantRepoLocalRegistries(rootPath: string): Promise<string[]> {
  const resolvedRootPath = path.resolve(rootPath);
  const pending = [resolvedRootPath];
  const registryCandidates: Array<{ registryPath: string; shadowedPath: string }> = [];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath) continue;

    const entries = await (async () => {
      try {
        return await fs.readdir(currentPath, { withFileTypes: true });
      } catch {
        return null;
      }
    })();
    if (!entries) continue;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const entryPath = path.join(currentPath, entry.name);
      if (entry.name === repoLocalDirName()) {
        if (currentPath !== resolvedRootPath) {
          registryCandidates.push({
            registryPath: path.join(entryPath, "config", "registry.yaml"),
            shadowedPath: currentPath,
          });
        }
        continue;
      }
      if (repoLocalScanSkipDirNames().has(entry.name)) continue;

      pending.push(entryPath);
    }
  }

  const shadowedPaths = await Promise.all(
    registryCandidates.map(async ({ registryPath, shadowedPath }) => {
      try {
        const stats = await fs.stat(registryPath);
        return stats.isFile() ? shadowedPath : null;
      } catch {
        // A missing or unreadable registry is not a shadowed link.
        return null;
      }
    }),
  );
  return shadowedPaths.filter((candidate): candidate is string => candidate !== null).sort();
}
