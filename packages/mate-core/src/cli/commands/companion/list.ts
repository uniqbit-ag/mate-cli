import path from "node:path";

import { fileExists } from "../../../lib/fs-utils";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { CompanionResolver, CompanionStore } from "../../../lib/orchestrator/repository-link";
import { resolveFrameworkContext } from "../../../lib/orchestrator/framework-context";
import type { LinkedRepository } from "../../../lib/orchestrator/types";
import { checkoutAt } from "../../../runtime/git-layout";
import { renderCompanionListTable } from "../../repo-list-table";
import { writeJsonStdout } from "../../write-json-stdout";

/** A companion the Working Repository points to; `repositoryId` is its ID in that companion. */
export interface ConnectedCompanion {
  path: string;
  repositoryId: string;
  active: boolean;
}

/** In a Working Repository: its connected companions. In a companion root: its linked repositories. */
export type CompanionListing =
  | { workingRepository: { id: string; path: string }; companions: ConnectedCompanion[] }
  | { companionPath: string; repositories: LinkedRepository[] };

/** Read-only: never self-heals the repo-local cache or prunes stale pointers. */
export async function listCompanionContext(
  cwd: string,
  globalConfigStore = new GlobalConfigStore(),
): Promise<CompanionListing> {
  const { companionPath, workingRepoStore, repository, contextKind } =
    await resolveFrameworkContext(cwd, globalConfigStore, { write: false });

  if (contextKind !== "working-repo" && !(contextKind === "env" && repository)) {
    // A companion that never linked a repository has no registry file yet.
    const repositories = (await fileExists(workingRepoStore.configPath))
      ? await new CompanionStore(companionPath, workingRepoStore).listRepositories()
      : [];
    return { companionPath, repositories };
  }

  const { match, ambiguousMatches } = await new CompanionResolver(
    globalConfigStore,
  ).resolveWithDiagnostics(cwd, { write: false });
  const matches = ambiguousMatches.length > 0 ? ambiguousMatches : match ? [match] : [];
  const active = path.resolve(companionPath);
  const companions = matches.map((m) => ({
    path: m.companionPath,
    repositoryId: m.repositoryId,
    active: path.resolve(m.companionPath) === active,
  }));
  // A session's companion the repo-local registry lacks still is the one in use.
  if (!companions.some((companion) => companion.active)) {
    companions.unshift({
      path: active,
      repositoryId: repository?.id ?? match?.repositoryId ?? "",
      active: true,
    });
  }

  // Without a repo-local cache (fresh clone or new worktree) the resolver's match names the repository.
  const workingRepository = repository
    ? { id: repository.id, path: repository.path }
    : { id: companions.find((c) => c.active)!.repositoryId, path: checkoutAt(cwd)?.root ?? cwd };

  return { workingRepository, companions };
}

/**
 * @command mate companion list
 * @description In a Working Repository, lists the companions it is connected
 * to, marking the one Mate resolves as active. In a companion root, lists the
 * Working Repositories linked to that companion.
 * @flags
 * - `--json` — force JSON output instead of the rendered table.
 * @remarks Output is also switched to JSON automatically when stdout is not a
 * TTY (e.g. piped into another command). Never writes a registry file.
 */
export async function runCompanionListCommand(argv: string[] = []): Promise<void> {
  const listing = await listCompanionContext(process.cwd());
  const forceJson = argv.includes("--json");

  if (forceJson || !process.stdout.isTTY) {
    await writeJsonStdout(listing);
    return;
  }

  await renderCompanionListTable(listing);
}
