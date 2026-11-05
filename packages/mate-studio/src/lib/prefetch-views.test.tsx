import { describe, expect, it } from "bun:test";

import type { CompanionView, CompanionViewData } from "../server/views";

await import("../../test/dom");
const { act, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { prefetchViews, usePrefetchViews } = await import("./prefetch-views");
const { companionViewQuery, factoryQuery, reportsQuery, vaultQuery } =
  await import("./studio-queries");

const search = { companion: "0123456789" };
const data = { error: null, studioMode: "engineering", warnings: [] } as CompanionViewData;

/** Answers each view at once and records the order it was asked in. */
function recording() {
  const asked: CompanionView[] = [];
  const query = (view: CompanionView) => ({
    queryKey: companionViewQuery(view, search).queryKey,
    queryFn: async () => {
      asked.push(view);
      return data;
    },
  });
  return { asked, query: query as never };
}

describe("prefetchViews", () => {
  it("loads the mode's companion views in order, never Factory, Vault or Reports", async () => {
    const queryClient = new QueryClient();
    const { asked, query } = recording();
    const preloaded: CompanionView[] = [];
    await prefetchViews(queryClient, search, "engineering", {
      query,
      preload: async (view) => preloaded.push(view),
    });
    expect(asked).toEqual(["dashboard", "workflow", "skills", "specs"]);
    expect(preloaded).toEqual(asked);
  });

  it("loads only what the analysis mode offers", async () => {
    const { asked, query } = recording();
    await prefetchViews(new QueryClient(), search, "analysis", { query });
    expect(asked).not.toContain("workflow");
    expect(asked).not.toContain("skills");
    expect(asked).toContain("dashboard");
  });

  it("skips views whose data is held", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(companionViewQuery("workflow", search).queryKey, data, {
      updatedAt: 0,
    });
    const { asked, query } = recording();
    await prefetchViews(queryClient, search, "engineering", { query });
    expect(asked).toEqual(["dashboard", "skills", "specs"]);
  });

  it("stops when cancelled", async () => {
    const { asked, query } = recording();
    await prefetchViews(new QueryClient(), search, "engineering", {
      query,
      cancelled: () => asked.length > 0,
    });
    expect(asked).toEqual(["dashboard"]);
  });

  it("preloads nothing once cancelled during a fetch", async () => {
    const { asked, query } = recording();
    const preloaded: CompanionView[] = [];
    await prefetchViews(new QueryClient(), search, "engineering", {
      query,
      preload: async (view) => preloaded.push(view),
      cancelled: () => asked.length > 0,
    });
    expect(asked).toEqual(["dashboard"]);
    expect(preloaded).toEqual([]);
  });
});

describe("usePrefetchViews", () => {
  async function mountOn() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = router.createRootRoute({
      component: function Page() {
        usePrefetchViews(search, "engineering");
        return null;
      },
    });
    const instance = router.createRouter({
      routeTree: root,
      history: router.createMemoryHistory({ initialEntries: ["/"] }),
    });
    const page = render(
      <QueryClientProvider client={queryClient}>
        <router.RouterProvider router={instance} />
      </QueryClientProvider>,
    );
    await act(async () => {
      await instance.load();
      await new Promise((done) => setTimeout(done, 400));
    });
    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    page.unmount();
    return keys;
  }

  it("loads ahead once the page is idle", async () => {
    expect(await mountOn()).toContainEqual(companionViewQuery("dashboard", search).queryKey);
  });

  it("loads the Vault's root listing and the Reports list, never Factory data", async () => {
    const keys = await mountOn();
    expect(keys).toContainEqual(vaultQuery(search.companion, {}).queryKey);
    expect(keys).toContainEqual(reportsQuery(search.companion).queryKey);
    expect(keys).not.toContainEqual(factoryQuery(search.companion).queryKey);
  });
});
