import fs from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";

import { frameworkConfig } from "../../framework";
import { resolveGitInfoExcludePath } from "../../tools/setup/git-utils";
import { YamlFileStore } from "./yaml-file-store";
import type { CompanionSource, LinkedRepository } from "./types";

export interface RepoLocalCompanionPointer {
  path: string;
  repositoryId: string;
  source?: CompanionSource;
}

export interface RepoLocalRegistry {
  repository?: LinkedRepository;
  companions: RepoLocalCompanionPointer[];
}

// Lazy: the distribution name is only known once createMate has run.
const repoLocalDirName = () => `.${frameworkConfig.name}`;
const repoLocalExcludeEntry = () => `${repoLocalDirName()}/`;
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

export function repoLocalDirPath(repoPath: string): string {
  return path.join(path.resolve(repoPath), repoLocalDirName());
}

export function repoLocalRegistryPath(repoPath: string): string {
  return path.join(repoLocalDirPath(repoPath), "config", "registry.yaml");
}

export function repoLocalFrameworkPath(repoPath: string): string {
  return path.join(repoLocalDirPath(repoPath), "config", "framework.yaml");
}

export class RepoLocalRegistryStore extends YamlFileStore<RepoLocalRegistry> {
  protected async onMissing(): Promise<RepoLocalRegistry> {
    return { companions: [] };
  }
}

/**
 * Adds the working repo's `.mate` directory to `.git/info/exclude` so it
 * never needs a tracked `.gitignore` entry, mirroring `ensureTokensaveStoreExcluded`.
 */
export async function ensureRepoLocalDirExcluded(repoPath: string): Promise<void> {
  const excludePath = await resolveGitInfoExcludePath(repoPath);
  if (!excludePath) return;

  let existing = "";
  try {
    existing = await fs.readFile(excludePath, "utf8");
  } catch {
    // Fresh repos may not have created info/exclude yet.
  }

  const lines = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.includes(repoLocalExcludeEntry())) return;

  lines.push(repoLocalExcludeEntry());
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, lines.join("\n") + "\n", "utf8");
}

/** Writes `.mate/config/framework.yaml` with `type: "working"` if it does not already exist. */
export async function writeRepoLocalFrameworkConfig(repoPath: string): Promise<void> {
  const frameworkPath = repoLocalFrameworkPath(repoPath);
  try {
    await fs.access(frameworkPath);
    return;
  } catch {
    // fall through to create it
  }

  await fs.mkdir(path.dirname(frameworkPath), { recursive: true });
  await fs.writeFile(frameworkPath, stringify({ type: "working" }), "utf8");
}

async function loadRepoLocalRegistry(repoPath: string): Promise<RepoLocalRegistry> {
  const store = new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath));
  return store.load();
}

async function saveRepoLocalRegistry(repoPath: string, registry: RepoLocalRegistry): Promise<void> {
  const store = new RepoLocalRegistryStore(repoLocalRegistryPath(repoPath));
  await store.save(registry);
}

function normalizeLinkedRepository(repository: LinkedRepository): LinkedRepository {
  return {
    ...repository,
    path: path.resolve(repository.path),
  };
}

async function upsertRepoLocalLinkedRepository(
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

/**
 * Single entry point for the dual-write at link time: ensures the `.mate`
 * directory exists, is git-excluded, has a working-repo `framework.yaml`,
 * and records the companion pointer in the repo-local registry.
 */
export async function writeRepoLocalRegistryEntry(
  repoPath: string,
  companionPath: string,
  repository: LinkedRepository,
  source: CompanionSource,
): Promise<void> {
  await ensureRepoLocalDirExcluded(repoPath);
  await writeRepoLocalFrameworkConfig(repoPath);
  await upsertRepoLocalLinkedRepository(repoPath, repository);
  await upsertRepoLocalCompanionPointer(repoPath, companionPath, repository.id, source);
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
): Promise<{ repoRoot: string; registryPath: string } | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = repoLocalRegistryPath(dir);
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) {
        return { repoRoot: dir, registryPath: candidate };
      }
    } catch {
      // keep walking up
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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

export async function pathIsDirectory(candidatePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(candidatePath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}
