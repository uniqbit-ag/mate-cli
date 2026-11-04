import type { QueryClient, QueryExecuteOptions, QueryKey } from "@tanstack/react-query";

import type { StudioSearch } from "./search";
import { shellQuery } from "./studio-queries";

/** Cached data as it is, however old, else fetched: what `ensureQueryData` returned. */
export function loadHeld<T, TKey extends QueryKey>(
  queryClient: QueryClient,
  options: QueryExecuteOptions<T, Error, T, T, TKey>,
): Promise<T> {
  return queryClient.query({ ...options, staleTime: "static" });
}

/**
 * The address's companion when it is registered, else `null`. The layout shows the picker then,
 * so a view loader loads nothing rather than failing the page.
 */
export async function registeredCompanion(
  queryClient: QueryClient,
  search: StudioSearch,
): Promise<string | null> {
  if (!search.companion) return null;
  const shell = await loadHeld(
    queryClient,
    shellQuery({ companion: search.companion, studioMode: search.studioMode }),
  );
  return shell.selected?.digest ?? null;
}

/**
 * A view loader's data: awaited on the server, so the first response carries it; started but
 * not awaited in the browser, so navigation switches at once and the view suspends meanwhile.
 * Held data is left as it is, so a hover preload reads nothing; the view's own query refreshes
 * it in the background when stale.
 */
export async function loadView<T, TKey extends QueryKey>(
  queryClient: QueryClient,
  options: QueryExecuteOptions<T, Error, T, T, TKey>,
  // Replaced at build time, so the server bundle never takes the browser branch.
  onServer = Boolean(import.meta.env.SSR),
): Promise<T | null> {
  // The first response needs data, not fresh data.
  if (onServer) return loadHeld(queryClient, options);
  // Only missing data is fetched; a failure surfaces through the view's own query, not the route.
  void loadHeld(queryClient, options).catch(() => {});
  return null;
}
