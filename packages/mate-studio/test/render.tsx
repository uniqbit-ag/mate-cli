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

/** `element` inside a router, for mounting views whose links need one. */
export function inRouter(element: ReactElement): ReactElement {
  return <RouterContextProvider router={contextRouter}>{element}</RouterContextProvider>;
}

/** Static markup of `element` with a router and query client around it, synchronously. */
export function staticMarkup(element: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouterContextProvider router={contextRouter}>{element}</RouterContextProvider>
    </QueryClientProvider>,
  );
}
