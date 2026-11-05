import { describe, expect, it } from "bun:test";
import type { StudioChange, StudioCompanionPayload } from "@uniqbit/mate-core/studio";

await import("../../../test/dom");
const { act, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { staticMarkup } = await import("../../../test/render");
const { Dashboard } = await import("./dashboard");
const { vaultQuery } = await import("../../lib/studio-queries");

const change = (
  name: string,
  done: number | undefined,
  total: number | undefined,
  extra: Partial<StudioChange> = {},
): StudioChange => ({
  name,
  completedTasks: done,
  totalTasks: total,
  artifacts: [],
  ...extra,
});

const changes = [
  change("acme-review", 0, 16),
  change("acme-build", 12, 20),
  change("acme-ready", 7, 7),
];

const payload = (list: StudioChange[], warnings: string[] = []) =>
  ({ changes: list, warnings }) satisfies Pick<StudioCompanionPayload, "changes" | "warnings">;

/** The Overview at `/`, with the `change` address the route reads. */
async function mount(list: StudioChange[], client = new QueryClient(), companion?: string) {
  const root = router.createRootRoute();
  const route = router.createRoute({
    getParentRoute: () => root,
    path: "/",
    validateSearch: (raw: { change?: unknown }) =>
      typeof raw.change === "string" ? { change: raw.change } : {},
    component: function Overview() {
      const { change: selected } = route.useSearch();
      return <Dashboard payload={payload(list)} selected={selected} companion={companion} />;
    },
  });
  const instance = router.createRouter({
    routeTree: root.addChildren([route]),
    history: router.createMemoryHistory({ initialEntries: ["/"] }),
  });
  await instance.load();
  const page = render(
    <QueryClientProvider client={client}>
      <router.RouterProvider router={instance} />
    </QueryClientProvider>,
  );
  await act(async () => {});
  return { page, instance, doc: page.container.ownerDocument };
}

const settle = () => act(async () => new Promise((done) => setTimeout(done, 20)));

/** The list cards' names, in order. */
const groups = (doc: Document) =>
  [...doc.querySelectorAll(".list-card h2")].map((heading) => heading.textContent);

const panel = (doc: Document) => doc.querySelector('[data-slot="sheet-content"]');

describe("Dashboard", () => {
  it("lists each change once under what it needs, in order, and no specs or skills", () => {
    const markup = staticMarkup(<Dashboard payload={payload(changes)} />);
    const order = ["Needs you", "Building", "Ready to archive"].map((title) =>
      markup.indexOf(`>${title}</h2>`),
    );
    expect(order.every((index) => index !== -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const name of ["acme-review", "acme-build", "acme-ready"]) {
      expect(markup.split(`data-change="${name}"`)).toHaveLength(2);
    }
    expect(markup.indexOf('data-change="acme-review"')).toBeLessThan(
      markup.indexOf(">Building</h2>"),
    );
    expect(markup).not.toContain("Specs by Area");
    expect(markup).not.toContain("mate-apply-change");
  });

  it("shows a change's progress as done of total with a bar", () => {
    const markup = staticMarkup(<Dashboard payload={payload([change("acme-build", 12, 20)])} />);
    expect(markup).toContain("12 of 20 tasks");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="60"');
  });

  it("says so when a change tracks no tasks, and lists it under Needs you", () => {
    const markup = staticMarkup(
      <Dashboard payload={payload([change("acme-new", undefined, undefined)])} />,
    );
    expect(markup).toContain("No tasks");
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).toContain(">Needs you</h2>");
  });

  it("puts a change with a validation issue under Needs you, naming the issue count", () => {
    const markup = staticMarkup(
      <Dashboard
        payload={payload([change("acme-broken", 7, 7, { valid: false, issueCount: 2 })])}
      />,
    );
    expect(markup).toContain(">Needs you</h2>");
    expect(markup).not.toContain(">Ready to archive</h2>");
    expect(markup).toContain("2 validation issues");
    expect(markup).toContain("Invalid");
  });

  it("hides a group without changes, and says when no change is in flight", () => {
    expect(
      staticMarkup(<Dashboard payload={payload([change("acme-build", 1, 2)])} />),
    ).not.toContain(">Needs you</h2>");
    const empty = staticMarkup(<Dashboard payload={payload([])} />);
    expect(empty).toContain("No change is in flight in this companion.");
    expect(empty).not.toContain("list-card");
  });

  it("reports degraded collection without costing the list", () => {
    const markup = staticMarkup(<Dashboard payload={payload(changes, ["openspec list failed"])} />);
    expect(markup).toContain("openspec list failed");
    expect(markup).toContain("acme-build");
  });

  it("narrows to one group with a filter that shows its count", async () => {
    const { doc, page } = await mount(changes);
    const filter = [
      ...doc.querySelectorAll<HTMLButtonElement>('[aria-label="Show changes"] button'),
    ];
    expect(filter.map((button) => button.textContent)).toEqual([
      "All3",
      "Needs you1",
      "Building1",
      "Ready to archive1",
    ]);
    await act(async () => filter[2]!.click());
    expect(groups(doc)).toEqual(["Building"]);
    page.unmount();
  });

  it("opens a change in the panel, walks it with Next, and keeps it in the address", async () => {
    const { doc, instance, page } = await mount(changes);
    await act(async () =>
      doc.querySelector<HTMLButtonElement>('[data-change="acme-review"]')!.click(),
    );
    await settle();
    expect(instance.state.location.search).toMatchObject({ change: "acme-review" });
    const open = panel(doc)!;
    expect(open.textContent).toContain("1 of 3");
    expect(open.textContent).toContain("Human review");
    expect(open.textContent).toContain("/mate-apply-change acme-review");
    expect(open.querySelector('[data-copy="/mate-apply-change acme-review"]')).not.toBeNull();
    await act(async () =>
      open.querySelector<HTMLButtonElement>('button[aria-label="Next"]')!.click(),
    );
    await settle();
    expect(instance.state.location.search).toMatchObject({ change: "acme-build" });
    expect(panel(doc)!.textContent).toContain("2 of 3");
    page.unmount();
  });

  it("walks only what needs the person in a review pass", async () => {
    const list = [change("acme-a", 0, 3), change("acme-b", 1, 3), change("acme-c", 0, 4)];
    const { doc, instance, page } = await mount(list);
    const start = [...doc.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Start review pass"),
    )!;
    await act(async () => start.click());
    await settle();
    expect(instance.state.location.search).toMatchObject({ change: "acme-a" });
    expect(panel(doc)!.textContent).toContain("1 of 2 · Needs you");
    await act(async () =>
      panel(doc)!.querySelector<HTMLButtonElement>('button[aria-label="Next"]')!.click(),
    );
    await settle();
    expect(instance.state.location.search).toMatchObject({ change: "acme-c" });
    page.unmount();
  });

  it("reads a written artifact in the panel for review, and goes back to the summary", async () => {
    const client = new QueryClient();
    const path = "openspec/changes/acme-review/proposal.md";
    client.setQueryData(vaultQuery("0123456789", { path }).queryKey, {
      open: { path, content: "", token: "t", markdown: [{ t: "h1", c: ["Acme proposal"] }] },
    } as never);
    const review = change("acme-review", 0, 4, {
      artifacts: [
        { id: "proposal", status: "done" },
        { id: "design", status: "ready" },
      ],
    } as Partial<StudioChange>);
    const { doc, page } = await mount([review], client, "0123456789");
    await act(async () =>
      doc.querySelector<HTMLButtonElement>('[data-change="acme-review"]')!.click(),
    );
    await settle();
    const sections = [...panel(doc)!.querySelectorAll("section h3")].map((h) => h.textContent);
    expect(sections[0]).toStartWith("Artifacts");
    expect(panel(doc)!.querySelector<HTMLButtonElement>('[data-artifact="design"]')!.disabled).toBe(
      true,
    );
    await act(async () =>
      panel(doc)!.querySelector<HTMLButtonElement>('[data-artifact="proposal"]')!.click(),
    );
    await settle();
    expect(panel(doc)!.querySelector(".markdown-body h1")?.textContent).toBe("Acme proposal");
    const back = [...panel(doc)!.querySelectorAll("button")].find((button) =>
      button.textContent?.trim().endsWith("Artifacts"),
    )!;
    await act(async () => back.click());
    await settle();
    expect(panel(doc)!.querySelector(".markdown-body")).toBeNull();
    expect(panel(doc)!.textContent).toContain("Next step");
    page.unmount();
  });
});
