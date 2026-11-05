import { describe, expect, it } from "bun:test";

await import("../../../test/dom");
const { act, render: mountDom } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { staticMarkup } = await import("../../../test/render");
const { ReportDetail, Reports } = await import("./reports-view");
const { reportsQuery } = await import("../../lib/studio-queries");

const listed = [
  { id: "b".repeat(32), title: "Acme newer review", createdAt: Date.UTC(2026, 1, 4) },
  { id: "a".repeat(32), title: "Acme older review", createdAt: Date.UTC(2026, 1, 3) },
];

describe("Reports", () => {
  it("states that there are none, with no empty card", () => {
    const markup = staticMarkup(<Reports companion="0123456789" />);
    expect(markup).toContain('aria-label="Hosted reports"');
    expect(markup).toContain("No hosted reports yet.");
    expect(markup).not.toContain("list-card");
    expect(markup).not.toContain('id="reports-frame"');
  });

  it("lists reports newest first", async () => {
    const root = router.createRootRoute();
    const route = router.createRoute({
      getParentRoute: () => root,
      path: "/reports",
      component: () => <Reports companion="0123456789" />,
    });
    const instance = router.createRouter({
      routeTree: root.addChildren([route]),
      history: router.createMemoryHistory({ initialEntries: ["/reports"] }),
    });
    await instance.load();
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(reportsQuery("0123456789").queryKey, listed);
    const page = mountDom(
      <QueryClientProvider client={client}>
        <router.RouterProvider router={instance} />
      </QueryClientProvider>,
    );
    await act(async () => new Promise((done) => setTimeout(done, 20)));
    const doc = page.container.ownerDocument;
    const rows = [...doc.querySelectorAll<HTMLButtonElement>("[data-report-id]")];
    expect(rows.map((row) => row.querySelector("[data-report-title]")?.textContent)).toEqual([
      "Acme newer review",
      "Acme older review",
    ]);
    expect(doc.querySelector("#reports-frame")).toBeNull();
    page.unmount();
  });

  it("shows a report in a sandboxed frame with a link to open it on its own", () => {
    const markup = staticMarkup(
      <ReportDetail report={listed[1]!} src={`/studio/reports/${"a".repeat(32)}`} />,
    );
    expect(markup).toContain('id="reports-frame"');
    expect(markup).toContain('sandbox="allow-scripts allow-modals"');
    expect(markup).toContain(`src="/studio/reports/${"a".repeat(32)}"`);
    expect(markup).toMatch(/id="reports-open"[^>]*target="_blank"/);
  });
});
