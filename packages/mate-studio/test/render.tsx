import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** Static markup of `element` rendered at `/factory` inside a router and query client. */
export async function renderMarkup(element: ReactElement, path = "/factory"): Promise<string> {
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path, component: () => element });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const contextRoot = createRootRoute();
const contextRouter = createRouter({
  routeTree: contextRoot,
  history: createMemoryHistory({
    initialEntries: ["/?companion=0123456789&role=business-analyst"],
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
