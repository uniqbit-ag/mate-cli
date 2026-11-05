import { describe, expect, it } from "bun:test";

import type { ShellData } from "../server/shell";

await import("../../test/dom");
const { act, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider, useSuspenseQuery } =
  await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { loadView } = await import("../lib/queries");
const { shellQuery } = await import("../lib/studio-queries");
const { StudioLayout } = await import("./layout");
const { ViewPlaceholder } = await import("./navigation-progress");
const { getRouter } = await import("../router");

const acme = {
  digest: "0123456789",
  path: "/home/dev/.mate/companions/acme-companion",
  note: "",
  unready: false,
  pairings: [],
};

const shell: ShellData = {
  companions: [acme],
  selected: acme,
  studioMode: "engineering",
  enabledModes: ["engineering", "analysis"],
  profile: "standard",
  collectedAt: null,
  metrics: null,
  writable: false,
  factoryMode: false,
  terminal: null,
};

const search = { companion: acme.digest };

/** Studio's layout over two views: `/` reads `overview`, `/specs` reads `specs`. */
async function mount(fetchers: { overview: () => Promise<string>; specs: () => Promise<string> }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(shellQuery(search).queryKey, shell);
  const viewQuery = (name: "overview" | "specs") => ({
    queryKey: ["view", name],
    queryFn: fetchers[name],
  });
  const root = router.createRootRouteWithContext<{
    queryClient: InstanceType<typeof QueryClient>;
  }>()({
    component: () => <StudioLayout search={search} />,
  });
  const view = (name: "overview" | "specs", path: string, studioView: "dashboard" | "specs") =>
    router.createRoute({
      getParentRoute: () => root,
      path,
      staticData: { view: studioView },
      loader: ({ context }) => loadView(context.queryClient, viewQuery(name), false),
      component: function View() {
        const { data } = useSuspenseQuery(viewQuery(name));
        return <p className="view-data">{data}</p>;
      },
    });
  const instance = router.createRouter({
    routeTree: root.addChildren([
      view("overview", "/", "dashboard"),
      view("specs", "/specs", "specs"),
    ]),
    context: { queryClient },
    defaultPendingComponent: getRouter().options.defaultPendingComponent,
    history: router.createMemoryHistory({ initialEntries: [`/?companion=${acme.digest}`] }),
  });
  const page = render(
    <QueryClientProvider client={queryClient}>
      <router.RouterProvider router={instance} />
    </QueryClientProvider>,
  );
  await act(async () => {
    await instance.load();
  });
  return { page, instance, queryClient };
}

const settle = () => act(async () => new Promise((done) => setTimeout(done, 10)));

describe("navigation", () => {
  it("shows the view placeholder while a view waits", () => {
    expect(getRouter().options.defaultPendingComponent).toBe(ViewPlaceholder);
  });

  it("switches at once to a placeholder while the next view's data loads", async () => {
    const { page, instance } = await mount({
      overview: async () => "acme overview",
      specs: () => new Promise<string>(() => {}),
    });
    await settle();
    expect(page.container.querySelector(".view-data")?.textContent).toBe("acme overview");

    await act(async () => {
      await instance.navigate({ to: "/specs", search });
    });
    await settle();

    expect(instance.state.location.pathname).toBe("/specs");
    expect(page.container.querySelector(".view-placeholder")).not.toBeNull();
    // React keeps the previous view hidden until the next one is ready.
    expect(page.container.querySelector('.view-data:not([style*="display: none"])')).toBeNull();
    expect(page.container.querySelector("nav#studio-rail")).not.toBeNull();
    expect(page.container.querySelector(".page-header h1")?.textContent).toBe("Specs");
    expect(page.container.querySelector('[aria-current="page"]')?.textContent).toContain("Specs");
    page.unmount();
  });

  it("shows held data at once and refreshes it quietly when stale", async () => {
    let calls = 0;
    const refresh = Promise.withResolvers<string>();
    const { page, instance, queryClient } = await mount({
      overview: async () => (calls++ === 0 ? "held overview" : refresh.promise),
      specs: async () => "acme specs",
    });
    await settle();
    await act(async () => {
      await instance.navigate({ to: "/specs", search });
    });
    await settle();
    // The overview's data is old now, so returning to it refreshes it in the background.
    queryClient.setQueryData(["view", "overview"], "held overview", { updatedAt: 0 });

    await act(async () => {
      await instance.navigate({ to: "/", search });
    });

    expect(page.container.querySelector(".view-data")?.textContent).toBe("held overview");
    expect(page.container.querySelector(".view-placeholder")).toBeNull();
    expect(page.container.querySelector(".nav-progress")?.getAttribute("data-pending")).toBe(
      "false",
    );
    expect(queryClient.getQueryState(["view", "overview"])?.fetchStatus).toBe("fetching");

    await act(async () => refresh.resolve("fresh overview"));
    await settle();
    expect(page.container.querySelector(".view-data")?.textContent).toBe("fresh overview");
    page.unmount();
  });

  it("keeps the frame while the root waits for another companion's shell", async () => {
    const { Route: studioRoot } = await import("../routes/__root");
    const waiting = new Promise<void>(() => {});
    const root = router.createRootRoute({
      validateSearch: (raw: { companion?: unknown }) =>
        typeof raw.companion === "string" ? { companion: raw.companion } : {},
      loaderDeps: ({ search }) => search,
      loader: ({ deps }) => (deps.companion === "9876543210" ? waiting : undefined),
      pendingMs: studioRoot.options.pendingMs,
      component: () => (
        <>
          <nav id="studio-rail">acme frame</nav>
          <router.Outlet />
        </>
      ),
    });
    const instance = router.createRouter({
      routeTree: root.addChildren([
        router.createRoute({ getParentRoute: () => root, path: "/", component: () => null }),
      ]),
      defaultPendingMs: 20,
      defaultPendingComponent: getRouter().options.defaultPendingComponent,
      history: router.createMemoryHistory({ initialEntries: [`/?companion=${acme.digest}`] }),
    });
    const page = render(<router.RouterProvider router={instance} />);
    await act(async () => {
      await instance.load();
    });

    await act(async () => {
      void instance.navigate({ to: "/", search: { companion: "9876543210" } });
      await new Promise((done) => setTimeout(done, 100));
    });

    expect(instance.state.status).toBe("pending");
    expect(page.container.querySelector("nav#studio-rail")?.textContent).toBe("acme frame");
    expect(page.container.querySelector(".view-placeholder")).toBeNull();
    page.unmount();
  });

  it("keeps the held data when its background refresh fails", async () => {
    let calls = 0;
    const { page, instance, queryClient } = await mount({
      overview: async () => {
        if (calls++ === 0) return "held overview";
        throw new Error("offline");
      },
      specs: async () => "acme specs",
    });
    await settle();
    await act(async () => {
      await instance.navigate({ to: "/specs", search });
    });
    await settle();
    queryClient.setQueryData(["view", "overview"], "held overview", { updatedAt: 0 });

    await act(async () => {
      await instance.navigate({ to: "/", search });
    });
    await settle();

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(page.container.querySelector(".view-data")?.textContent).toBe("held overview");
    page.unmount();
  });
});
