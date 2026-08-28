import fs from "node:fs/promises";
import path from "node:path";

import { stringify } from "yaml";

import { repoLocalFrameworkPath, repoLocalRegistryPath } from "../../runtime/repo-local";
import { YamlFileStore } from "./yaml-file-store";
import type { CompanionSource, LinkedRepository } from "./types";

/**
 * The repo-local registry's shape and its writers. Split from
 * `repo-local-registry.ts` so the Managed Projection's catalogue can declare
 * these writes without importing the module that calls the projection owner.
 */

export interface RepoLocalCompanionPointer {
  path: string;
  repositoryId: string;
  source?: CompanionSource;
}

export interface RepoLocalRegistry {
  repository?: LinkedRepository;
  companions: RepoLocalCompanionPointer[];
}

export class RepoLocalRegistryStore extends YamlFileStore<RepoLocalRegistry> {
  protected async onMissing(): Promise<RepoLocalRegistry> {
    return { companions: [] };
  }
}

/** Writes `.mate/config/framework.yaml` with `type: "working"` if it does not already exist. */
export async function writeRepoLocalFrameworkConfig(repoPath: string): Promise<boolean> {
  const frameworkPath = repoLocalFrameworkPath(repoPath);
  try {
    await fs.access(frameworkPath);
    return false;
  } catch {
    // fall through to create it
  }

  await fs.mkdir(path.dirname(frameworkPath), { recursive: true });
  await fs.writeFile(frameworkPath, stringify({ type: "working" }), "utf8");
  return true;
}

async function loadRepoLocalRegistry(repoPath: string): Promise<RepoLocalRegistry> {
  const store = new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath));
  return store.load();
}

async function saveRepoLocalRegistry(repoPath: string, registry: RepoLocalRegistry): Promise<void> {
  const store = new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath));
  await store.save(registry);
}

// Field-explicit on purpose: also strips legacy per-repo policy fields
// (profile/overrides) from entries read from or written to disk.
export function normalizeLinkedRepository(repository: LinkedRepository): LinkedRepository {
  return {
    id: repository.id,
    path: path.resolve(repository.path),
  };
}

export async function upsertRepoLocalLinkedRepository(
  repoPath: string,
  repository: LinkedRepository,
): Promise<void> {
  const registry = await loadRepoLocalRegistry(repoPath);
  registry.repository = normalizeLinkedRepository(repository);
  await saveRepoLocalRegistry(repoPath, registry);
}

/** Upserts a companion pointer (by path) into the working repo's local registry. */
export async function upsertRepoLocalCompanionPointer(
  repoPath: string,
  companionPath: string,
  repositoryId: string,
  source: CompanionSource,
): Promise<void> {
  const resolvedCompanionPath = path.resolve(companionPath);
  const registry = await loadRepoLocalRegistry(repoPath);
  const existingIndex = registry.companions.findIndex(
    (pointer) => path.resolve(pointer.path) === resolvedCompanionPath,
  );

  if (existingIndex >= 0) {
    registry.companions[existingIndex] = { path: resolvedCompanionPath, repositoryId, source };
  } else {
    registry.companions.push({ path: resolvedCompanionPath, repositoryId, source });
  }

  await saveRepoLocalRegistry(repoPath, registry);
}
