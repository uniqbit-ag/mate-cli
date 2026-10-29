import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../framework";
import { companionRegistryPath, registryLinks } from "../../runtime/companion-registry-read";
import { withPathLock } from "../../runtime/companion-lock";
import { checkoutCommonDir, checkoutRootOf, namesOtherCheckout } from "../../runtime/git-layout";
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
import {
  type MergedEntry,
  reconcileRegistry,
  registeredCheckoutOf,
  registryListsRepository,
} from "./registry-checkouts";
import { project, projectWorkingRepository } from "./working-repo-projection";
import { readProjectionFile } from "../../runtime/projection";
import { GRAPHIFY_STORE_SEGMENT } from "../../tools/setup/capabilities/graphify";
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

  /**
   * One load and save under the registry's own lock: hand over or drop dead
   * entries, merge hand-linked Checkouts of one clone, reuse the clone's entry
   * or upsert by ID, and record each clone's shared Git folder. Returns the
   * entry it kept. After the save, outside the lock, the asking folder's
   * repo-local link takes the kept ID, as do the Checkouts of merged-away
   * entries; those writes only warn.
   */
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

    const registryPath = this.companionRegistryStore.configPath;
    const locked = await withPathLock(
      REGISTRY_LOCK_NAMESPACE,
      existingRealPath(registryPath),
      {},
      async () => {
        // A companion's registry.yaml may not exist yet (its first-ever link):
        // that is not a real error here, unlike a working repo reading its own
        // missing config, so fall back to an empty registry instead of throwing.
        const working = await this.companionRegistryStore.load().catch((error) => {
          if (error instanceof ConfigError) return CompanionRegistryStore.defaultConfig();
          throw error;
        });
        const reconciled = reconcileRegistry(working.repos, repository);
        working.repos = reconciled.repos;
        await this.companionRegistryStore.save(working);
        return reconciled;
      },
    );
    if (!locked.acquired) {
      throw new ConfigError(
        `another ${FRAMEWORK_NAME} process is still writing ${registryPath}; try again.`,
      );
    }

    const { kept, merged } = locked.value;
    const companionPath = path.resolve(this.companionPath);
    const source = options.companionSource ?? "git";
    // Repo-local registry write is a cache, not the source of truth: the
    // companion-side write above already succeeded, so a failure here (e.g. a
    // read-only working tree) must not fail the overall link operation.
    try {
      await writeRepoLocalRegistryEntry(
        repository.path,
        companionPath,
        { id: kept.id, path: repository.path },
        source,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `mate: warning: failed to write repo-local registry for ${repository.path}: ${message}`,
      );
    }
    for (const entry of merged) {
      // oxlint-disable-next-line no-await-in-loop -- one notice per merged Checkout, in order
      await relinkMergedCheckout(companionPath, entry, source);
    }

    return kept;
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

/** The companion registry's own lock, apart from the companion's sync lock. */
const REGISTRY_LOCK_NAMESPACE = "companion-registry";

/** Real path of the nearest existing ancestor, plus the rest: a first link has no file yet. */
function existingRealPath(target: string): string {
  const rest: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fsSync.realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Points a merged-away Checkout's link, and its projection when it has one, at
 * the kept ID, and says that the Graphify graph under the old ID is unused.
 */
async function relinkMergedCheckout(
  companionPath: string,
  { removed, kept }: MergedEntry,
  source: CompanionSource,
): Promise<void> {
  const graph = path.join(companionPath, GRAPHIFY_STORE_SEGMENT, removed.id);
  console.error(
    `${FRAMEWORK_NAME}: merged ${removed.id} (${removed.path}) into ${kept.id}, the entry of its clone in ${companionPath}; ${removed.path} now uses ${kept.id}, and the Graphify graph stored under ${removed.id} (${graph}) is no longer used.`,
  );
  const repository = { id: kept.id, path: removed.path };
  try {
    await writeRepoLocalRegistryEntry(removed.path, companionPath, repository, source);
    if (readProjectionFile(removed.path)) {
      const projected = await projectWorkingRepository(companionPath, repository);
      if (projected.kind === "failed") throw projected.error;
    }
  } catch (error) {
    console.error(
      `${FRAMEWORK_NAME}: warning: failed to point ${removed.path} at ${kept.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export { registeredCheckoutOf };

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
    /** A launch from another Checkout of the clone never moves the entry to it. */
    if (registryListsRepository(repos, repository)) return;

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

export interface ResolveOptions {
  logFailures?: boolean;
  /** `false` looks up without the self-heal or the stale-pointer prune, so a caller can refuse first. */
  write?: boolean;
}

/**
 * The repo-local cache a single companion-scan match restores: `repository`
 * names `folder`, and `companions` is replaced by the one pointer, without a
 * `source`. Direct save, not `project("link")`: that scope also writes git
 * excludes, the Projection Root, the companion link and the repo-local
 * framework.yaml, and it upserts the pointer instead of replacing `companions`.
 * For a new Checkout of a linked clone this is its Adoption, and its contents
 * depend only on the match, so concurrent Adoptions end in the same file.
 */
export async function writeRepoLocalCache(folder: string, match: CompanionMatch): Promise<void> {
  const store = new RepoLocalRegistryStore(repoLocalRegistryPath(folder));
  /** `repository` too: wrap and unwrap resolve the Repository Link from it. */
  await store.save({
    ...(await store.load().catch(() => ({}))),
    repository: { id: match.repositoryId, path: folder },
    companions: [{ path: match.companionPath, repositoryId: match.repositoryId }],
  });
}

export class CompanionResolver {
  constructor(private readonly globalConfigStore: GlobalConfigStore) {}

  async resolve(cwd: string): Promise<CompanionMatch | null> {
    return (await this.resolveWithDiagnostics(cwd, { logFailures: true })).match;
  }

  async resolveWithDiagnostics(
    cwd: string,
    options: ResolveOptions = {},
  ): Promise<CompanionResolutionResult> {
    const resolvedCwd = path.resolve(cwd);

    const repoLocalResult = await this.resolveFromRepoLocalRegistry(resolvedCwd, options);
    if (repoLocalResult) return repoLocalResult;

    return this.resolveFromGlobalRegistry(resolvedCwd, options);
  }

  /**
   * Fallback for when the repo-local cache is missing or unusable: scans
   * every companion the global registry knows about and matches by
   * repository path, or by clone when the folder is inside a Git Checkout of
   * an entry's clone. A single match self-heals the repo-local cache at the
   * matched folder (the Checkout's root for a clone match) so the fast path
   * succeeds on the next resolution without repeating this scan; for a new
   * Checkout of a linked clone, that is its Adoption. A registration is a
   * claim (ADR-025): `link/..` names where it leads, and one leading nowhere
   * matches nothing rather than the folder it normalises to.
   */
  private async resolveFromGlobalRegistry(
    resolvedCwd: string,
    options: ResolveOptions,
  ): Promise<CompanionResolutionResult> {
    const candidates = await this.globalConfigStore.list();
    const checkoutRoot = checkoutRootOf(resolvedCwd)?.root;
    const clone = checkoutRoot ? checkoutCommonDir(checkoutRoot) : null;
    const found = await Promise.all(
      candidates.map(async (candidate) => {
        const companionPath = normalisedCanonicalPath(candidate);
        if (companionPath === null) return null;
        try {
          const { repos } = await readCompanionRegistry(companionPath);
          const byPath = repos.find((r) => path.resolve(r.path) === resolvedCwd);
          if (byPath) {
            return { companionPath, repositoryId: byPath.id, folder: resolvedCwd };
          }
          const byClone = clone ? repos.find((r) => entryOfClone(r, clone)) : undefined;
          return byClone && checkoutRoot
            ? { companionPath, repositoryId: byClone.id, folder: checkoutRoot }
            : null;
        } catch {
          return null;
        }
      }),
    );

    const matched = found.filter((match) => match !== null);
    const matches = uniqueByCompanion(
      matched.map(({ companionPath, repositoryId }) => ({ companionPath, repositoryId })),
    );

    if (matches.length === 0) return { match: null, ambiguousMatches: [], failures: [] };

    if (matches.length === 1 && options.write !== false) {
      await writeRepoLocalCache(matched[0]!.folder, matches[0]!);
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
    options: ResolveOptions,
  ): Promise<CompanionResolutionResult | null> {
    const found = await findRepoLocalRegistryFile(resolvedCwd);
    if (!found) return null;

    let pointers: RepoLocalCompanionPointer[];
    try {
      const raw = await fs.readFile(found.registryPath, "utf8");
      const parsed = parse(raw) as { companions?: unknown; repository?: { path?: unknown } } | null;
      if (!parsed || !Array.isArray(parsed.companions)) return null;
      /** A cache copied from another Checkout of the clone is that Checkout's, not this one's. */
      const named = parsed.repository?.path;
      if (typeof named === "string" && namesOtherCheckout(found.repoRoot, named)) return null;
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

    if (stale.length > 0 && options.write !== false) {
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

/** An entry of the clone whose shared Git folder is `clone`: recorded, else read from its live path. */
function entryOfClone(entry: LinkedRepository, clone: string): boolean {
  return (
    entry.gitCommonDir === clone ||
    (fsSync.existsSync(entry.path) && checkoutCommonDir(entry.path) === clone)
  );
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

/**
 * The Repository Link the nearest repo-local registry records. A link naming
 * another live Checkout of the clone, as in a `.mate/` folder copied from it,
 * counts as absent, so the Checkout is adopted instead of acting as that one.
 * A link naming a missing folder is returned as before.
 */
export async function findRepoLocalLinkedRepository(cwd: string): Promise<LinkedRepository | null> {
  const found = await findRepoLocalRegistryFile(cwd);
  if (!found) return null;

  try {
    const raw = await fs.readFile(found.registryPath, "utf8");
    const parsed = parse(raw) as Partial<RepoLocalRegistry> | null;
    if (!parsed?.repository) return null;
    const repository = normalizeLinkedRepository(parsed.repository);
    return namesOtherCheckout(found.repoRoot, repository.path) ? null : repository;
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
