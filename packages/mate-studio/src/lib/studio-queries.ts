import { hashKey, type QueryClient, queryOptions } from "@tanstack/react-query";
import type { StudioEvent, VaultView } from "@uniqbit/mate-core/studio";

import { agentCredentialKey } from "./agent-credential";
import type { StudioSearch } from "./search";
import { getFactory } from "../server/factory";
import { getShell } from "../server/shell";
import { getVault, getVaultChildren, getVaultMatches } from "../server/vault";
import { type CompanionView, getCompanionView } from "../server/views";

/**
 * Every companion-scoped Studio query, and which of them each trigger makes stale. Keys start
 * with the companion digest (`null` when none is selected), so one prefix is one companion.
 */
const keys = {
  companion: (companion: string | null) => [companion] as const,
  shell: (companion: string | null) => [companion, "shell"] as const,
  views: (companion: string | null) => [companion, "view"] as const,
  factory: (companion: string) => [companion, "factory"] as const,
  vault: (companion: string) => [companion, "vault"] as const,
  vaultViews: (companion: string) => [companion, "vault", "view"] as const,
  reports: (companion: string) => [companion, "reports"] as const,
};

/** Per file and per filter, so unbounded; dropped a while after their last use. */
const VAULT_GC_MS = 5 * 60_000;

export interface VaultSearch {
  path?: string;
  dir?: string;
  mode?: "edit";
}

export interface ReportSummary {
  id: string;
  title: string;
  createdAt: number;
}

export const shellQuery = (search: StudioSearch) =>
  queryOptions({
    queryKey: [...keys.shell(search.companion ?? null), search.studioMode ?? null],
    queryFn: () => getShell({ data: search }),
  });

export const companionViewQuery = (view: CompanionView, search: StudioSearch) =>
  queryOptions({
    queryKey: [...keys.views(search.companion ?? null), view, search.studioMode ?? null],
    queryFn: () => getCompanionView({ data: { ...search, view } }),
  });

export const factoryQuery = (companion: string) =>
  queryOptions({
    queryKey: keys.factory(companion),
    queryFn: () => getFactory({ data: { companion } }),
    // Events update the board in place; this only covers a missed one (design D7).
    refetchInterval: 30_000,
  });

export const vaultQuery = (companion: string, search: VaultSearch, wait = false) =>
  queryOptions({
    queryKey: [...keys.vaultViews(companion), search.path ?? null, search.dir ?? null, wait],
    queryFn: () => getVault({ data: { companion, path: search.path, dir: search.dir, wait } }),
    gcTime: VAULT_GC_MS,
  });

export const vaultChildrenQuery = (companion: string, dir: string) =>
  queryOptions({
    queryKey: [...keys.vault(companion), "children", dir],
    queryFn: () => getVaultChildren({ data: { companion, dir } }),
  });

export const vaultMatchesQuery = (companion: string, query: string) =>
  queryOptions({
    queryKey: [...keys.vault(companion), "matches", query],
    queryFn: () => getVaultMatches({ data: { companion, query } }),
    gcTime: VAULT_GC_MS,
  });

export const reportsQuery = (companion: string) =>
  queryOptions({
    queryKey: keys.reports(companion),
    queryFn: async (): Promise<ReportSummary[]> => {
      const response = await fetch(`/api/reports?companion=${encodeURIComponent(companion)}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      return ((await response.json()) as { reports: ReportSummary[] }).reports ?? [];
    },
  });

async function stale(queryClient: QueryClient, ...queryKeys: (readonly unknown[])[]) {
  await Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

/** After a server event for `companion`; views refetch in place (design D7). */
export async function afterEvent(
  queryClient: QueryClient,
  companion: string,
  type: StudioEvent["type"],
): Promise<void> {
  if (type === "board") {
    // A shown board's refetch collects afresh; the shell and views read what it collected, so
    // they wait for it. Without one, another tab may have collected, so they refetch at once.
    const board = queryClient.getQueryCache().find({ queryKey: keys.factory(companion) });
    if (board?.isActive()) {
      await stale(queryClient, keys.factory(companion));
      await stale(queryClient, keys.shell(companion), keys.views(companion));
    } else {
      await stale(
        queryClient,
        keys.factory(companion),
        keys.shell(companion),
        keys.views(companion),
      );
    }
  } else if (type === "reports") {
    await stale(queryClient, keys.reports(companion));
  }
  // `vault-tree` only marks the tree stale; the viewer refreshes it (studio-vault).
}

export const afterFactoryAction = (queryClient: QueryClient, companion: string) =>
  stale(queryClient, keys.factory(companion));

/** The refresh answer is shown at once; the companion's other vault reads follow. */
export function afterVaultRefresh(
  queryClient: QueryClient,
  companion: string,
  search: VaultSearch,
  fresh: VaultView,
): Promise<void> {
  const shown = vaultQuery(companion, search).queryKey;
  queryClient.setQueryData(shown, fresh);
  const answered = hashKey(shown);
  return queryClient.invalidateQueries({
    queryKey: keys.vault(companion),
    predicate: (query) => query.queryHash !== answered,
  });
}

/** After the open file changed on disk or was saved. */
export const afterVaultFileChange = (queryClient: QueryClient, companion: string) =>
  stale(queryClient, keys.vaultViews(companion));

/**
 * After Refresh collected `companion` again; other companions keep what they hold. The agent
 * credential is not companion data but may change out of band; terminal sessions are polled.
 */
export const afterRefresh = (queryClient: QueryClient, companion: string | undefined) =>
  stale(queryClient, keys.companion(companion ?? null), agentCredentialKey);
