import { hashKey, type QueryClient, queryOptions } from "@tanstack/react-query";
import type { SkillAgent, StudioEvent, StudioMode, VaultView } from "@uniqbit/mate-core/studio";

import { unpackGraph } from "./graph-wire";
import type { StudioSearch } from "./search";
import { studioFetch } from "./studio-fetch";
import { getGraph } from "../server/graph";
import { getReports } from "../server/reports";
import { getShell, type ShellData } from "../server/shell";
import { getSkillPreview } from "../server/skills";
import { getVault, getVaultChildren, getVaultMatches } from "../server/vault";
import { getWork } from "../server/work";
import { type CompanionView, getCompanionView } from "../server/views";

/**
 * Every companion-scoped Studio query, and which of them each trigger makes stale. Keys start
 * with the companion digest (`null` when none is selected), so one prefix is one companion.
 */
const keys = {
  companion: (companion: string | null) => [companion] as const,
  shell: (companion: string | null) => [companion, "shell"] as const,
  views: (companion: string | null) => [companion, "view"] as const,
  skills: (companion: string) => [companion, "skills"] as const,
  work: (companion: string) => [companion, "work"] as const,
  vault: (companion: string) => [companion, "vault"] as const,
  vaultViews: (companion: string) => [companion, "vault", "view"] as const,
  reports: (companion: string) => [companion, "reports"] as const,
  graph: (companion: string) => [companion, "graph"] as const,
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

/**
 * Holds the shell another enabled mode would read, built from the one shown: only the mode
 * differs, so switching waits for no request. Held as stale, so the server's copy follows.
 */
export function holdShellForMode(
  queryClient: QueryClient,
  search: StudioSearch,
  shell: ShellData,
  studioMode: StudioMode,
): void {
  const { queryKey } = shellQuery({ ...search, studioMode });
  if (queryClient.getQueryData(queryKey) !== undefined) return;
  queryClient.setQueryData(queryKey, { ...shell, studioMode }, { updatedAt: 0 });
}

export const companionViewQuery = (view: CompanionView, search: StudioSearch) =>
  queryOptions({
    queryKey: [...keys.views(search.companion ?? null), view, search.studioMode ?? null],
    queryFn: () => getCompanionView({ data: { ...search, view } }),
  });

export const skillPreviewQuery = (
  companion: string,
  agent: SkillAgent,
  name: string,
  file?: string,
) =>
  queryOptions({
    queryKey: [...keys.skills(companion), agent, name, file ?? null],
    queryFn: () => getSkillPreview({ data: { companion, agent, name, file } }),
  });

/** A plugin view's attention count from its service's route; a board change refetches it. */
export const pluginAttentionQuery = (companion: string, url: string) =>
  queryOptions({
    queryKey: [...keys.views(companion), "plugin-attention", url],
    queryFn: async (): Promise<number> => {
      const response = await studioFetch(`${url}?companion=${encodeURIComponent(companion)}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return 0;
      const answer = (await response.json()) as { count?: unknown };
      return typeof answer.count === "number" ? answer.count : 0;
    },
    // Board events refetch it; this only covers a missed one.
    refetchInterval: 30_000,
  });

/** Work's buckets; board events make it stale. */
export const workQuery = (companion: string) =>
  queryOptions({
    queryKey: keys.work(companion),
    queryFn: () => getWork({ data: { companion } }),
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
    queryFn: () => getReports({ data: { companion } }),
  });

/** Never loaded ahead: Core builds the graph only when the Graph view asks for it. */
export const graphQuery = (companion: string) =>
  queryOptions({
    queryKey: keys.graph(companion),
    queryFn: async () => unpackGraph(await getGraph({ data: { companion } })),
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
    // A shown Work view's refetch collects afresh; the shell and views read what it collected,
    // so they wait for it. Without one, another tab may have collected, so they refetch at once.
    const shown =
      queryClient
        .getQueryCache()
        .find({ queryKey: keys.work(companion) })
        ?.isActive() === true;
    if (shown) {
      await stale(queryClient, keys.work(companion));
      await stale(queryClient, keys.shell(companion), keys.views(companion));
    } else {
      await stale(queryClient, keys.work(companion), keys.shell(companion), keys.views(companion));
    }
  } else if (type === "reports") {
    await stale(queryClient, keys.reports(companion));
  }
  // `vault-tree` only marks the tree stale; the viewer refreshes it (studio-vault).
}

export const afterWorkAction = (queryClient: QueryClient, companion: string) =>
  stale(queryClient, keys.work(companion), keys.views(companion));

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

/** After Refresh collected `companion` again; other companions keep what they hold. */
export const afterRefresh = (queryClient: QueryClient, companion: string | undefined) =>
  stale(queryClient, keys.companion(companion ?? null));
