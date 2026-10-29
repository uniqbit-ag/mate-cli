import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../framework";
import { companionRegistryPath, registryLinks } from "../../runtime/companion-registry-read";
import { canonicalPath, normalisedCanonicalPath } from "../../runtime/physical-path";
import {
  ancestorDirectories,
  repoLocalDirName,
  repoLocalRegistryPath,
  type RepoLocalRegistryFile,
} from "../../runtime/repo-local";
import { pathIsDirectory } from "../fs-utils";
import { CompanionRegistryStore } from "./companion-registry-store";
import type { GlobalConfigStore } from "./global-config-store";
import { firstFailure } from "./projection-types";
import {
  normalizeLinkedRepository,
  type RepoLocalCompanionPointer,
  type RepoLocalRegistry,
  RepoLocalRegistryStore,
} from "./repo-local-store";
import { project } from "./working-repo-projection";
import { type CompanionSource, ConfigError, type LinkedRepository } from "./types";

/**
 * The Repository Link: the companion's `registry.yaml` is the source of
 * truth, the Working Repository's repo-local `registry.yaml` is a cache. Every
 * rule for persisting, reading, pruning, migrating, backfilling and
 * self-healing a link lives here; `CompanionRegistryStore` and
 * `repo-local-store.ts` only know the file shapes.
 */

// ---------------------------------------------------------------------------
// Link, get and list (update read: migrates legacy registries on load)
// ---------------------------------------------------------------------------

/** Builds a {@link CompanionStore} whose registry file lives under `<companionPath>/.mate/config`, regardless of `process.cwd()`. */
export function companionRootedStore(companionPath: string): CompanionStore {
  return new CompanionStore(
    companionPath,
    new CompanionRegistryStore(companionRegistryPath(companionPath)),
  );
}

export class CompanionStore {
  constructor(
    private readonly companionPath = process.cwd(),
    private readonly companionRegistryStore = new CompanionRegistryStore(),
  ) {}

  async registerRepository(
    repository: LinkedRepository,
    options: { companionSource?: CompanionSource } = {},
  ): Promise<LinkedRepository> {
    const stats = await fs.stat(repository.path).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new ConfigError(
        `Linked repository path must exist and be a directory: ${repository.path}`,
      );
    }

    // A companion's registry.yaml may not exist yet (its first-ever link):
    // that is not a real error here, unlike a working repo reading its own
    // missing config, so fall back to an empty registry instead of throwing.
    const working = await this.companionRegistryStore.load().catch((error) => {
      if (error instanceof ConfigError) return CompanionRegistryStore.defaultConfig();
      throw error;
    });

    // Prune dead entries (path no longer a directory) as part of this same
    // write, piggybacking on the load/save that registration already does
    // rather than adding a separate scan; never runs on a read-only list.
    const checked = await Promise.all(
      working.repos.map(async (repo) => ({ repo, exists: await pathIsDirectory(repo.path) })),
    );
    const survivors = checked.filter((entry) => entry.exists).map((entry) => entry.repo);

    const existing = survivors.findIndex((r) => r.id === repository.id);
    if (existing >= 0) {
      survivors[existing] = repository;
    } else {
      survivors.push(repository);
    }
    working.repos = survivors;
    await this.companionRegistryStore.save(working);

    // Repo-local registry write is a cache, not the source of truth: the
    // companion-side write above already succeeded, so a failure here (e.g. a
    // read-only working tree) must not fail the overall link operation.
    try {
      await writeRepoLocalRegistryEntry(
        repository.path,
        path.resolve(this.companionPath),
        repository,
        options.companionSource ?? "git",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `mate: warning: failed to write repo-local registry for ${repository.path}: ${message}`,
      );
    }

    return repository;
  }

  async getRepository(repositoryId: string): Promise<LinkedRepository | undefined> {
    const working = await this.companionRegistryStore.load();
    return working.repos.find((r) => r.id === repositoryId);
  }

  async listRepositories(): Promise<LinkedRepository[]> {
    const working = await this.companionRegistryStore.load();
    return working.repos;
  }
}

// ---------------------------------------------------------------------------
// Pure read of the companion registry (never writes)
// ---------------------------------------------------------------------------

export { companionRegistryPath };

export interface CompanionRegistryReadResult {
  repos: LinkedRepository[];
}

/**
 * Parses a companion's `registry.yaml` without the writes {@link
 * CompanionRegistryStore.load} performs (legacy-field migration, stale-pointer
 * cleanup). Callers that must not mutate registry state on a read (e.g.
 * inventory, materialization) use this instead. Throws ENOENT when the file
 * doesn't exist; throws on unparsable YAML.
 */
export async function readCompanionRegistry(
  companionPath: string,
): Promise<CompanionRegistryReadResult> {
  const raw = await fs.readFile(companionRegistryPath(companionPath), "utf8");
  return { repos: registryLinks(parse(raw)) };
}

// ---------------------------------------------------------------------------
// Launch backfill
// ---------------------------------------------------------------------------

/**
 * Self-heals repos linked before the companion-side registry write existed
 * (or whose companion registry was reset): backfills the companion-side
 * entry from the already-trusted repo-local pointer on every launch
 * resolution. Best-effort — never blocks a launch.
 */
export async function backfillCompanionRegistration(
  companionPath: string,
  repository: LinkedRepository,
): Promise<void> {
  try {
    const { repos } = await readCompanionRegistry(companionPath).catch(() => ({ repos: [] }));
    const existing = repos.find((repo) => repo.id === repository.id);
    if (existing?.path === repository.path) return;

    await companionRootedStore(companionPath).registerRepository(repository);
  } catch (error) {
    console.error(
      `${FRAMEWORK_NAME}: warning: failed to backfill companion registry for ${repository.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Resolution: repo-local cache first, companion scan as fallback
// ---------------------------------------------------------------------------

export interface CompanionMatch {
  companionPath: string;
  repositoryId: string;
}

export interface CompanionResolutionFailure {
  companionPath: string;
  message: string;
}

export interface CompanionResolutionResult {
  match: CompanionMatch | null;
  /**
   * All companions whose registry links the same repo path at the best
   * (longest) match length as `match`. Populated with more than one entry
   * only when the same working repo is linked from more than one distinct
   * companion, so callers that must pick a single companion (e.g. launch
   * commands) can detect the ambiguity and prompt the user instead of
   * silently using whichever companion happened to be listed first.
   */
  ambiguousMatches: CompanionMatch[];
  failures: CompanionResolutionFailure[];
}

export class CompanionResolver {
  constructor(private readonly globalConfigStore: GlobalConfigStore) {}

  async resolve(cwd: string): Promise<CompanionMatch | null> {
    return (await this.resolveWithDiagnostics(cwd, { logFailures: true })).match;
  }

  async resolveWithDiagnostics(
    cwd: string,
    options: { logFailures?: boolean } = {},
  ): Promise<CompanionResolutionResult> {
    const resolvedCwd = path.resolve(cwd);

    const repoLocalResult = await this.resolveFromRepoLocalRegistry(resolvedCwd, options);
    if (repoLocalResult) return repoLocalResult;

    return this.resolveFromGlobalRegistry(resolvedCwd);
  }

  /**
   * Fallback for when the repo-local cache is missing or unusable: scans
   * every companion the global registry knows about and matches by
   * repository path. A single match self-heals the repo-local cache so the
   * fast path succeeds on the next resolution without repeating this scan.
   * A registration is a claim (ADR-025): `link/..` names where it leads, and
   * one leading nowhere matches nothing rather than the folder it normalises to.
   */
  private async resolveFromGlobalRegistry(resolvedCwd: string): Promise<CompanionResolutionResult> {
    const candidates = await this.globalConfigStore.list();
    const found = await Promise.all(
      candidates.map(async (candidate) => {
        const companionPath = normalisedCanonicalPath(candidate);
        if (companionPath === null) return null;
        try {
          const { repos } = await readCompanionRegistry(companionPath);
          const repo = repos.find((r) => path.resolve(r.path) === resolvedCwd);
          return repo ? { companionPath, repositoryId: repo.id } : null;
        } catch {
          return null;
        }
      }),
    );

    const matches = uniqueByCompanion(
      found.filter((match): match is CompanionMatch => match !== null),
    );

    if (matches.length === 0) return { match: null, ambiguousMatches: [], failures: [] };

    if (matches.length === 1) {
      // Direct save, not `project("link")`: that scope also writes git
      // excludes, the Projection Root, the companion link and the repo-local
      // framework.yaml, and it upserts the pointer instead of replacing
      // `companions`. A read-side self-heal must only restore the cache.
      const store = new RepoLocalRegistryStore(repoLocalRegistryPath(resolvedCwd));
      /** `repository` too: wrap and unwrap resolve the Repository Link from it. */
      await store.save({
        ...(await store.load().catch(() => ({}))),
        repository: { id: matches[0]!.repositoryId, path: resolvedCwd },
        companions: [{ path: matches[0]!.companionPath, repositoryId: matches[0]!.repositoryId }],
      });
    }

    return resolvedTo(matches);
  }

  /**
   * Fast path: reads the working repo's own `.mate/config/registry.yaml`
   * before scanning every registered companion. Treats the file as the
   * working repo's source of truth for companion pointers: existing
   * directories are accepted immediately, stale paths are dropped, and
   * absence of usable local data means the repo is not linked. A pointer
   * written `link/..` names where it leads, as the kernel would.
   */
  private async resolveFromRepoLocalRegistry(
    resolvedCwd: string,
    options: { logFailures?: boolean },
  ): Promise<CompanionResolutionResult | null> {
    const found = await findRepoLocalRegistryFile(resolvedCwd);
    if (!found) return null;

    let pointers: RepoLocalCompanionPointer[];
    try {
      const raw = await fs.readFile(found.registryPath, "utf8");
      const parsed = parse(raw) as { companions?: unknown } | null;
      if (!parsed || !Array.isArray(parsed.companions)) return null;
      pointers = parsed.companions as RepoLocalCompanionPointer[];
    } catch {
      return null;
    }

    if (pointers.length === 0) return null;

    const checkedPointers = await Promise.all(
      pointers.map(async (pointer) => {
        const companionPath = canonicalPath(pointer.path);
        return { pointer, companionPath, exists: await pathIsDirectory(companionPath) };
      }),
    );
    const live = checkedPointers.filter((entry) => entry.exists);
    const stale = checkedPointers.filter((entry) => !entry.exists);

    if (options.logFailures) {
      for (const { companionPath } of stale) {
        console.error(
          `mate: dropping stale repo-local companion pointer (no longer exists): ${companionPath}`,
        );
      }
    }

    if (stale.length > 0) {
      const survivors: RepoLocalCompanionPointer[] = live.map(({ pointer, companionPath }) => ({
        path: companionPath,
        repositoryId: pointer.repositoryId,
        source: pointer.source,
      }));
      // Direct save, not `project("link")`: pruning only removes pointers, and
      // that scope would also write the projection files and could only
      // upsert, never drop, a pointer.
      const store = new RepoLocalRegistryStore(found.registryPath);
      await store.save({ ...(await store.load()), companions: survivors });
    }

    if (live.length === 0) return null;

    return resolvedTo(
      uniqueByCompanion(
        live.map(({ pointer, companionPath }) => ({
          companionPath,
          repositoryId: pointer.repositoryId,
        })),
      ),
    );
  }
}

/** Keeps the first match per companion, so one companion linking a path twice is not ambiguous. */
function uniqueByCompanion(matches: CompanionMatch[]): CompanionMatch[] {
  const seenCompanionPaths = new Set<string>();
  return matches.filter((match) => {
    if (seenCompanionPaths.has(match.companionPath)) return false;
    seenCompanionPaths.add(match.companionPath);
    return true;
  });
}

/** `matches` is non-empty and deduplicated; more than one is an ambiguity. */
function resolvedTo(matches: CompanionMatch[]): CompanionResolutionResult {
  return {
    match: matches[0]!,
    ambiguousMatches: matches.length > 1 ? matches : [],
    failures: [],
  };
}

// ---------------------------------------------------------------------------
// Repo-local cache: write through the projection, look up by walking the tree
// ---------------------------------------------------------------------------

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

/** Walks up from `cwd` looking for the nearest ancestor holding a repo-local registry file. */
export async function findRepoLocalRegistryFile(
  cwd: string,
): Promise<RepoLocalRegistryFile | null> {
  for (const dir of ancestorDirectories(cwd)) {
    const candidate = repoLocalRegistryPath(dir);
    try {
      // oxlint-disable-next-line no-await-in-loop -- the nearest ancestor wins, so stop at the first hit
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
  const skipDirNames = repoLocalScanSkipDirNames();

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath) continue;

    // oxlint-disable-next-line no-await-in-loop -- each listing feeds the queue the walk consumes
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => null);
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
      if (skipDirNames.has(entry.name)) continue;

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
  return shadowedPaths.filter((candidate): candidate is string => candidate !== null).toSorted();
}
