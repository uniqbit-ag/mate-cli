import {
  type QueryClient,
  type QueryExecuteOptions,
  type QueryKey,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { type StudioMode, type StudioView, viewsFor } from "@uniqbit/mate-core/studio";
import { useEffect } from "react";

import type { CompanionView } from "../server/views";
import { VIEW_PATHS } from "../shell/views";
import type { StudioSearch } from "./search";
import { companionViewQuery, reportsQuery, vaultQuery } from "./studio-queries";

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
      if (cancelled()) return;
    }
    // oxlint-disable-next-line no-await-in-loop -- route code follows its data
    await preload?.(view).catch(() => {});
  }
}

/** Loads each view's route code, one chunk at a time, until `cancelled`. */
async function loadViewCode(
  router: ReturnType<typeof useRouter>,
  views: readonly StudioView[],
  cancelled: () => boolean,
): Promise<void> {
  const routes = router.routesByPath as unknown as Record<string, unknown>;
  for (const view of views) {
    if (cancelled()) return;
    const route = routes[VIEW_PATHS[view]];
    if (!route) continue;
    // oxlint-disable-next-line no-await-in-loop -- one chunk at a time
    await Promise.resolve(router.loadRouteChunk(route as never)).catch(() => {});
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
 * While the page is idle, one item at a time: the code of every view the mode offers, the
 * mode's companion views, the Vault's root listing and the Reports list, then each other
 * enabled mode's Overview, so no first visit waits. Factory data is never loaded ahead: it
 * refreshes on its own events.
 */
export function usePrefetchViews(
  search: StudioSearch,
  studioMode: StudioMode,
  enabledModes: readonly StudioMode[] = [],
) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { companion } = search;
  const requestedMode = search.studioMode;
  // A string, so a new array with the same modes does not restart the effect.
  const otherModes = enabledModes.filter((mode) => mode !== studioMode).join(",");
  useEffect(() => {
    if (!companion) return;
    let stopped = false;
    const viewSearch = { companion, studioMode: requestedMode };
    const offered = viewsFor(studioMode);
    const load = async <T, TKey extends QueryKey>(
      options: QueryExecuteOptions<T, Error, T, T, TKey>,
    ) => {
      if (stopped || queryClient.getQueryData(options.queryKey) !== undefined) return;
      await queryClient.query(options).catch(() => {});
    };
    const cancel = whenIdle(() => {
      void (async () => {
        await loadViewCode(router, offered, () => stopped);
        if (stopped) return;
        await prefetchViews(queryClient, viewSearch, studioMode, {
          preload: (next) =>
            router.preloadRoute({ to: VIEW_PATHS[next], search: viewSearch } as never),
          cancelled: () => stopped,
        });
        if (offered.includes("vault")) await load(vaultQuery(companion, {}));
        if (offered.includes("reports")) await load(reportsQuery(companion));
        for (const mode of otherModes ? (otherModes.split(",") as StudioMode[]) : []) {
          // oxlint-disable-next-line no-await-in-loop -- one view at a time keeps the server quiet
          await load(companionViewQuery("dashboard", { companion, studioMode: mode }));
        }
      })();
    });
    return () => {
      stopped = true;
      cancel();
    };
  }, [companion, requestedMode, studioMode, otherModes, queryClient, router]);
}
