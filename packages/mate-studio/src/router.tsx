import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { routeTree } from "./route-tree.gen";
import { ViewPlaceholder } from "./shell/navigation-progress";
import { createStudioQueryClient } from "./lib/query-client";

/** One router and query client per request on the server, one per page in the browser. */
export function getRouter() {
  const queryClient = createStudioQueryClient();
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
