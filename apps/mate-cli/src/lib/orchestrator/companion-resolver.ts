import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import type { GlobalConfigStore } from "./global-config-store";
import {
  findRepoLocalRegistryFile,
  pathIsDirectory,
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
  constructor(_globalConfigStore: GlobalConfigStore) {}

  async resolve(cwd: string): Promise<CompanionMatch | null> {
    return (await this.resolveWithDiagnostics(cwd, { logFailures: true })).match;
  }

  async resolveWithDiagnostics(
    cwd: string,
    options: { logFailures?: boolean } = {},
  ): Promise<CompanionResolutionResult> {
    const resolvedCwd = path.resolve(cwd);

    const repoLocalResult = await this.resolveFromRepoLocalRegistry(resolvedCwd, options);
    return repoLocalResult ?? { match: null, ambiguousMatches: [], failures: [] };
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

    for (const pointer of pointers) {
      const companionPath = path.resolve(pointer.path);
      if (await pathIsDirectory(companionPath)) {
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
