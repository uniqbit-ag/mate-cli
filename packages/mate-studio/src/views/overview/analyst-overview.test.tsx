import { describe, expect, it } from "bun:test";
import { type StudioCompanionPayload, type StudioShippedChange } from "@uniqbit/mate-core/studio";

await import("../../../test/dom");
const { act, render: mountDom } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { staticMarkup } = await import("../../../test/render");
const { AnalystOverview } = await import("./analyst-overview");
const { recentlyChangedSpecs } = await import("./changed-specs");

function shipped(anchor: string, specs: string[], hasProposal = true): StudioShippedChange {
  return { name: anchor.slice(11), anchor, archivedOn: anchor.slice(0, 10), specs, hasProposal };
}

function payload(overrides: Partial<StudioCompanionPayload> = {}): StudioCompanionPayload {
  return {
    companionPath: "/home/dev/.mate/companions/acme-companion",
    changes: [
      {
        name: "add-active-work",
        completedTasks: 2,
        totalTasks: 5,
        status: "in-progress",
        artifacts: [{ id: "tasks" }],
      },
    ],
    specs: [
      { capability: "acme-login", areas: ["acme"], requirementCount: 3, valid: true },
      { capability: "acme-billing", areas: ["acme", "docs"], requirementCount: 4, valid: false },
    ],
    shipped: [
      shipped("2026-02-10-acme-checkout", ["acme-billing", "acme-login"]),
      shipped("2026-01-05-acme-minimal", ["acme-login"], false),
    ],
    skills: ["mate-grill-me"],
    skillInventory: { claude: ["mate-grill-me"], opencode: [], agents: [] },
    topology: null,
    warnings: [],
    ...overrides,
  } as StudioCompanionPayload;
}

function render(data = payload()): string {
  return staticMarkup(<AnalystOverview payload={data} />);
}

function hrefs(markup: string): URL[] {
  return [...markup.matchAll(/href="([^"]*)"/g)].map(
    ([, href]) => new URL(href.replaceAll("&amp;", "&"), "http://localhost:1"),
  );
}

describe("AnalystOverview", () => {
  it("shows what shipped and the specs it changed, not the spec summary or reports", () => {
    const markup = render();
    expect(markup).toContain("Recently shipped");
    expect(markup).toContain("Recently changed specs");
    expect(markup).not.toContain("What the system does");
    expect(markup).not.toContain("Recent reports");
  });

  it("lists shipped changes newest first under their day, with capabilities", () => {
    const markup = render();
    expect(markup.indexOf("acme-checkout")).toBeLessThan(markup.indexOf("acme-minimal"));
    expect(markup).toMatch(/<time dateTime="2026-02-10"[^>]*>2026-02-10<\/time>Tuesday/);
    expect(markup).toContain("acme-billing, acme-login");
  });

  it("puts changes archived on one day under one heading", () => {
    const sameDay = [
      shipped("2026-02-10-acme-one", []),
      shipped("2026-02-10-acme-two", []),
      shipped("2026-02-09-acme-three", []),
    ];
    const markup = render(payload({ shipped: sameDay }));
    expect([...markup.matchAll(/<time dateTime="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "2026-02-10",
      "2026-02-09",
    ]);
  });

  it("names each changed spec once, at its newest shipped change", () => {
    expect(recentlyChangedSpecs(payload().shipped)).toEqual([
      { capability: "acme-billing", change: "acme-checkout", archivedOn: "2026-02-10" },
      { capability: "acme-login", change: "acme-checkout", archivedOn: "2026-02-10" },
    ]);
  });

  it("caps each list", () => {
    const many = Array.from({ length: 24 }, (_, index) =>
      shipped(`2026-01-${String(index + 10)}-acme-${index}`, [`acme-spec-${index}`]),
    );
    const markup = render(payload({ shipped: many }));
    const rows = (label: string) =>
      (new RegExp(`aria-label="${label}"[\\s\\S]*?</section>`).exec(markup)?.[0] ?? "").split(
        "<li>",
      ).length - 1;
    expect(rows("Recently shipped")).toBe(20);
    expect(rows("Recently changed specs")).toBe(12);
    expect(markup).toContain("newest 20");
  });

  it("links into the vault and Specs, keeping the mode", () => {
    const links = hrefs(render());
    for (const link of links) expect(link.searchParams.get("studioMode")).toBe("analysis");
    // Each view has its own path now; the vault target is still named by `path` or `dir`.
    const targets = links.map((link) => [
      link.pathname.slice(1) || "dashboard",
      link.searchParams.get("path") ?? link.searchParams.get("dir"),
    ]);
    expect(targets).toContainEqual(["specs", null]);
    expect(targets).toContainEqual(["vault", "openspec/specs/acme-billing/spec.md"]);
  });

  it("opens a shipped change in the panel with its proposal and changed specs", async () => {
    const root = router.createRootRoute();
    const route = router.createRoute({
      getParentRoute: () => root,
      path: "/",
      component: () => <AnalystOverview payload={payload()} />,
    });
    const instance = router.createRouter({
      routeTree: root.addChildren([route]),
      history: router.createMemoryHistory({ initialEntries: ["/?studioMode=analysis"] }),
    });
    await instance.load();
    const page = mountDom(
      <QueryClientProvider client={new QueryClient()}>
        <router.RouterProvider router={instance} />
      </QueryClientProvider>,
    );
    await act(async () => {});
    const doc = page.container.ownerDocument;
    const rows = [
      ...doc.querySelectorAll<HTMLButtonElement>('[aria-label="Recently shipped"] button'),
    ];
    await act(async () => rows[0]!.click());
    await act(async () => new Promise((done) => setTimeout(done, 20)));
    const panel = doc.querySelector('[data-slot="sheet-content"]')!;
    const targets = [...panel.querySelectorAll("a")].map((link) =>
      new URL(link.getAttribute("href")!, "http://localhost").searchParams.get("path"),
    );
    expect(targets).toEqual([
      "openspec/changes/archive/2026-02-10-acme-checkout/proposal.md",
      "openspec/specs/acme-billing/spec.md",
      "openspec/specs/acme-login/spec.md",
    ]);
    await act(async () =>
      panel.querySelector<HTMLButtonElement>('button[aria-label="Next"]')!.click(),
    );
    await act(async () => new Promise((done) => setTimeout(done, 20)));
    const minimal = doc.querySelector('[data-slot="sheet-content"]')!;
    expect(minimal.textContent).toContain("This change has no proposal.");
    expect(
      new URL(minimal.querySelector("a")!.getAttribute("href")!, "http://x").searchParams.get(
        "dir",
      ),
    ).toBe("openspec/changes/archive/2026-01-05-acme-minimal");
    page.unmount();
  });

  it("shows no active change, task, workflow, or skill content", () => {
    const markup = render();
    expect(markup).not.toContain("add-active-work");
    expect(markup).not.toContain("2 / 5");
    expect(markup).not.toContain("mate-grill-me");
    expect(markup).not.toContain("progressbar");
  });

  it("gives each empty part a no-data message", () => {
    const markup = render(payload({ specs: [], shipped: [] }));
    expect(markup).toContain("No shipped changes yet.");
    expect(markup).toContain("No specs changed by shipped changes yet.");
  });
});
