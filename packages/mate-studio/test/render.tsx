import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const contextRoot = createRootRoute();
const contextRouter = createRouter({
  routeTree: contextRoot,
  history: createMemoryHistory({
    initialEntries: ["/?companion=0123456789&studioMode=analysis"],
  }),
});
await contextRouter.load();

/** Static markup of `element` with a router and query client around it, synchronously. */
export function staticMarkup(element: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouterContextProvider router={contextRouter}>{element}</RouterContextProvider>
    </QueryClientProvider>,
  );
}
