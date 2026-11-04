import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { type StudioMode, type StudioView, viewsFor } from "@uniqbit/mate-core/studio";
import { useEffect } from "react";

import type { CompanionView } from "../server/views";
import { VIEW_PATHS } from "../shell/views";
import type { StudioSearch } from "./search";
import { companionViewQuery } from "./studio-queries";

/** Views read from the held snapshot; Factory, Vault and Reports load their own way. */
const AHEAD: readonly CompanionView[] = ["dashboard", "workflow", "skills", "specs"];

interface PrefetchDeps {
  query?: typeof companionViewQuery;
  preload?: (view: CompanionView) => Promise<unknown>;
  cancelled?: () => boolean;
}

/**
 * Loads the mode's companion views one after another, skipping those already held, so the
 * first click on each is instant and the server is asked one view at a time.
 */
export async function prefetchViews(
  queryClient: QueryClient,
  search: StudioSearch,
  studioMode: StudioMode,
  { query = companionViewQuery, preload, cancelled = () => false }: PrefetchDeps = {},
): Promise<void> {
  const offered = viewsFor(studioMode);
  for (const view of AHEAD) {
    if (cancelled()) return;
    if (!offered.includes(view)) continue;
    const options = query(view, search);
    if (queryClient.getQueryData(options.queryKey) === undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one view at a time keeps the server quiet
      await queryClient.query(options).catch(() => {});
      // Navigating to the Vault meanwhile must not be followed by another page read.
      if (cancelled()) return;
    }
    // oxlint-disable-next-line no-await-in-loop -- route code follows its data
    await preload?.(view).catch(() => {});
  }
}

const whenIdle = (run: () => void): (() => void) => {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(run);
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(run, 200);
  return () => clearTimeout(handle);
};

/**
 * Loads the current mode's other companion views while the page is idle. Never runs while the
 * Vault is shown: every page read on the server deactivates the vault's watchers.
 */
export function usePrefetchViews(search: StudioSearch, studioMode: StudioMode, view: StudioView) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { companion } = search;
  const requestedMode = search.studioMode;
  const onVault = view === "vault";
  useEffect(() => {
    if (!companion || onVault) return;
    let stopped = false;
    const viewSearch = { companion, studioMode: requestedMode };
    const cancel = whenIdle(() => {
      void prefetchViews(queryClient, viewSearch, studioMode, {
        preload: (next) =>
          router.preloadRoute({ to: VIEW_PATHS[next], search: viewSearch } as never),
        cancelled: () => stopped,
      });
    });
    return () => {
      stopped = true;
      cancel();
    };
  }, [companion, requestedMode, studioMode, onVault, queryClient, router]);
}
