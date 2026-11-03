import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { routeTree } from "./route-tree.gen";

/** One router and query client per request on the server, one per page in the browser. */
export function getRouter() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}
