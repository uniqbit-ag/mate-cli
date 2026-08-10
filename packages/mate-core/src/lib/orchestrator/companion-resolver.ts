import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { readCompanionRegistry } from "./companion-registry-reader";
import type { GlobalConfigStore } from "./global-config-store";
import {
  findRepoLocalRegistryFile,
  pathIsDirectory,
  repoLocalRegistryPath,
  type RepoLocalCompanionPointer,
  RepoLocalRegistryStore,
} from "./repo-local-registry";

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
   */
  private async resolveFromGlobalRegistry(resolvedCwd: string): Promise<CompanionResolutionResult> {
    const candidates = await this.globalConfigStore.list();
    const found = await Promise.all(
      candidates.map(async (candidate) => {
        const companionPath = path.resolve(candidate);
        try {
          const { repos } = await readCompanionRegistry(companionPath);
          const repo = repos.find((r) => path.resolve(r.path) === resolvedCwd);
          return repo ? { companionPath, repositoryId: repo.id } : null;
        } catch {
          return null;
        }
      }),
    );

    const seenCompanionPaths = new Set<string>();
    const matches = found.filter((match): match is CompanionMatch => {
      if (!match || seenCompanionPaths.has(match.companionPath)) return false;
      seenCompanionPaths.add(match.companionPath);
      return true;
    });

    if (matches.length === 0) return { match: null, ambiguousMatches: [], failures: [] };

    if (matches.length === 1) {
      const store = new RepoLocalRegistryStore(repoLocalRegistryPath(resolvedCwd));
      await store.save({
        companions: [{ path: matches[0]!.companionPath, repositoryId: matches[0]!.repositoryId }],
      });
    }

    return {
      match: matches[0]!,
      ambiguousMatches: matches.length > 1 ? matches : [],
      failures: [],
    };
  }

  /**
   * Fast path: reads the working repo's own `.mate/config/registry.yaml`
   * before scanning every registered companion. Treats the file as the
   * working repo's source of truth for companion pointers: existing
   * directories are accepted immediately, stale paths are dropped, and
   * absence of usable local data means the repo is not linked.
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

    const survivors: RepoLocalCompanionPointer[] = [];
    const validMatches: CompanionMatch[] = [];
    let changed = false;

    const checkedPointers = await Promise.all(
      pointers.map(async (pointer) => {
        const companionPath = path.resolve(pointer.path);
        return { pointer, companionPath, exists: await pathIsDirectory(companionPath) };
      }),
    );

    for (const { pointer, companionPath, exists } of checkedPointers) {
      if (exists) {
        survivors.push({
          path: companionPath,
          repositoryId: pointer.repositoryId,
          source: pointer.source,
        });
        validMatches.push({ companionPath, repositoryId: pointer.repositoryId });
        continue;
      }

      changed = true;
      if (options.logFailures) {
        console.error(
          `mate: dropping stale repo-local companion pointer (no longer exists): ${companionPath}`,
        );
      }
    }

    if (changed) {
      const store = new RepoLocalRegistryStore(found.registryPath);
      await store.save({ companions: survivors });
    }

    if (validMatches.length === 0) return null;

    const seenCompanionPaths = new Set<string>();
    const ambiguousMatches = validMatches.filter((match) => {
      if (seenCompanionPaths.has(match.companionPath)) return false;
      seenCompanionPaths.add(match.companionPath);
      return true;
    });

    return {
      match: ambiguousMatches[0]!,
      ambiguousMatches: ambiguousMatches.length > 1 ? ambiguousMatches : [],
      failures: [],
    };
  }
}
