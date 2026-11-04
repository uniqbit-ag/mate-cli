import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { routeTree } from "./route-tree.gen";
import { ViewPlaceholder } from "./shell/navigation-progress";

/** One router and query client per request on the server, one per page in the browser. */
export function getRouter() {
  // Held for the page's life: a revisit shows its data at once and refreshes it if stale.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 5_000, gcTime: Infinity } },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    // A view waiting for its data shows this in its place; the layout around it stays.
    defaultPendingComponent: ViewPlaceholder,
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}
