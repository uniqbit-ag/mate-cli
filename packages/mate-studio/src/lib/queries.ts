import { type QueryClient, queryOptions } from "@tanstack/react-query";

import type { StudioSearch } from "./search";
import { getShell } from "../server/shell";

/** Query keys start with the view, then the companion, so an event can invalidate one view. */
const studioKeys = {
  shell: (search: StudioSearch) =>
    ["shell", search.companion ?? null, search.studioMode ?? null] as const,
};

export const shellQuery = (search: StudioSearch) =>
  queryOptions({
    queryKey: studioKeys.shell(search),
    queryFn: () => getShell({ data: search }),
  });

/**
 * The address's companion when it is registered, else `null`. The layout shows the picker then,
 * so a view loader loads nothing rather than failing the page.
 */
export async function registeredCompanion(
  queryClient: QueryClient,
  search: StudioSearch,
): Promise<string | null> {
  if (!search.companion) return null;
  const shell = await queryClient.ensureQueryData(
    shellQuery({ companion: search.companion, studioMode: search.studioMode }),
  );
  return shell.selected?.digest ?? null;
}
