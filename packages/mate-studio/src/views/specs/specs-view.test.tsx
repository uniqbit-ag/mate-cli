import { describe, expect, it } from "bun:test";
import {
  findAction,
  type SpecActionOffer,
  type StudioCompanionPayload,
} from "@uniqbit/mate-core/studio";

await import("../../../test/dom");
const { act, render: mountDom } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { staticMarkup } = await import("../../../test/render");
const { effectiveFilter, filterOptions, groupSpecs, NO_REPOSITORY } = await import("./spec-areas");
const { Specs } = await import("./specs-view");

type Spec = StudioCompanionPayload["specs"][number];
const spec = (capability: string, ...pairs: [string | undefined, string][]): Spec => ({
  capability,
  scopes: pairs.map(([repository, area]) => ({ ...(repository ? { repository } : {}), area })),
});

const shopWeb = spec("acme-login", ["acme/shop", "packages/web"]);
const blogWeb = spec("acme-posts", ["acme/blog", "packages/web"]);
const shopApi = spec("acme-search", ["acme/shop", "packages/api"], ["acme/shop", "packages/web"]);
const loose = spec("acme-legacy");
const SPECS = [shopWeb, blogWeb, shopApi, loose];

/** A section's capabilities, in order. */
const listed = (groups: ReturnType<typeof groupSpecs>) =>
  groups.map((group) => [
    group.repository,
    group.areas.map(({ area, specs }) => [area, specs.map((entry) => entry.capability)]),
  ]);

function payload(overrides: Partial<StudioCompanionPayload> = {}): StudioCompanionPayload {
  return {
    companionPath: "/home/dev/.mate/companions/acme-companion",
    changes: [],
    specs: [],
    shipped: [],
    topology: null,
    warnings: [],
    ...overrides,
  } as StudioCompanionPayload;
}

describe("Specs", () => {
  it("presents one card per Area under its repository, and none of the Dashboard's changes", () => {
    const markup = staticMarkup(
      <Specs
        payload={payload({
          changes: [{ name: "add-auth", artifacts: [] }],
          specs: [
            { ...spec("acme-login", ["acme/shop", "acme"]), requirementCount: 3 },
            { ...spec("acme-search", ["acme/shop", "docs"]), valid: false, issueCount: 2 },
          ],
        })}
      />,
    );
    expect(markup).toContain('aria-label="Specs by repository and Area"');
    expect(markup).toContain('aria-label="Repository acme/shop"');
    expect(markup).toContain('<section class="list-card');
    expect(markup).toContain('aria-label="Area acme"');
    expect(markup).toContain('aria-label="Area docs"');
    expect(markup).toMatch(
      /<h3[^>]*><span class="font-mono">acme<\/span><\/h3><span[^>]*>1<\/span>/,
    );
    // No sequence numbers before an Area.
    expect(markup).not.toMatch(/>0?1\.? *<\/span><span class="font-mono">acme/);
    expect(markup).toContain("3 requirements");
    expect(markup).toContain("2 issues");
    expect(markup).not.toContain('aria-label="Changes"');
    expect(markup).not.toContain("add-auth");
  });

  it("says so when the companion holds no spec", () => {
    expect(staticMarkup(<Specs payload={payload()} />)).toContain("No specs in this companion.");
  });

  it("reports collection warnings", () => {
    const markup = staticMarkup(
      <Specs payload={payload({ warnings: ["topology: unreadable"] })} />,
    );
    expect(markup).toContain("topology: unreadable");
  });

  it("renders an Area containing markup characters as text", () => {
    const markup = staticMarkup(
      <Specs payload={payload({ specs: [spec("c", ["<b>r</b>", "<i>a</i>"])] })} />,
    );
    expect(markup).not.toContain("<i>a</i>");
    expect(markup).not.toContain("<b>r</b>");
    expect(markup).toContain("&lt;i&gt;a&lt;/i&gt;");
  });

  it("narrows to the filters it is given and offers the companion's repositories", () => {
    const markup = staticMarkup(
      <Specs payload={payload({ specs: SPECS })} filter={{ repo: "acme/blog" }} />,
    );
    expect(markup).toContain("acme-posts");
    expect(markup).not.toContain("acme-login");
    expect(markup).toContain(">acme/shop (2)</option>");
    expect(markup).toContain(">No repository (1)</option>");
  });

  it("states that nothing matches and offers to clear", () => {
    const markup = staticMarkup(
      <Specs payload={payload({ specs: SPECS })} filter={{ q: "nothing-like-this" }} />,
    );
    expect(markup).toContain("No spec matches the search and filters.");
    expect(markup).toContain("Clear filters");
  });
});

describe("groupSpecs", () => {
  it("keeps one Area path in two repositories as two groups, No repository last", () => {
    expect(listed(groupSpecs(SPECS))).toEqual([
      ["acme/blog", [["packages/web", ["acme-posts"]]]],
      [
        "acme/shop",
        [
          ["packages/api", ["acme-search"]],
          ["packages/web", ["acme-login", "acme-search"]],
        ],
      ],
      [null, [["unassigned", ["acme-legacy"]]]],
    ]);
  });

  it("searches capability names and Areas ignoring case", () => {
    expect(listed(groupSpecs(SPECS, { q: "LOGIN" }))).toEqual([
      ["acme/shop", [["packages/web", ["acme-login"]]]],
    ]);
    expect(listed(groupSpecs(SPECS, { q: "API" }))).toEqual([
      ["acme/shop", [["packages/api", ["acme-search"]]]],
    ]);
  });

  it("combines repository and Area filters with search", () => {
    expect(
      listed(groupSpecs(SPECS, { repo: "acme/shop", area: "packages/web", q: "search" })),
    ).toEqual([["acme/shop", [["packages/web", ["acme-search"]]]]]);
    expect(listed(groupSpecs(SPECS, { repo: NO_REPOSITORY }))).toEqual([
      [null, [["unassigned", ["acme-legacy"]]]],
    ]);
  });
});

describe("No repository", () => {
  it("stays apart from a repository literally named none", () => {
    const named = spec("acme-named", ["none", "docs"]);
    expect(listed(groupSpecs([named, loose]))).toEqual([
      ["none", [["docs", ["acme-named"]]]],
      [null, [["unassigned", ["acme-legacy"]]]],
    ]);
    expect(filterOptions([named, loose]).repositories.map(({ value }) => value)).toEqual([
      "none",
      NO_REPOSITORY,
    ]);
  });
});

describe("filterOptions", () => {
  it("counts specs per repository and narrows Areas to the chosen repository", () => {
    const { repositories, areas } = filterOptions(SPECS, "acme/shop");
    expect(repositories.map(({ value, count }) => [value, count])).toEqual([
      ["acme/blog", 1],
      ["acme/shop", 2],
      [NO_REPOSITORY, 1],
    ]);
    expect(areas.map(({ area, count }) => [area, count])).toEqual([
      ["packages/api", 1],
      ["packages/web", 2],
    ]);
  });

  it("lists every repository's Areas under All", () => {
    expect(filterOptions(SPECS).areas.map(({ repo, area }) => `${repo} ${area}`)).toEqual([
      "acme/blog packages/web",
      "acme/shop packages/api",
      "acme/shop packages/web",
      `${NO_REPOSITORY} unassigned`,
    ]);
  });
});

describe("effectiveFilter", () => {
  it("treats values that name nothing as All", () => {
    const effective = (filter: { q?: string; repo?: string; area?: string }) =>
      effectiveFilter(filterOptions(SPECS, filter.repo), filter);
    expect(effective({ repo: "acme/missing", area: "packages/web" })).toEqual({});
    expect(effective({ repo: "acme/blog", area: "packages/api" })).toEqual({ repo: "acme/blog" });
    expect(effective({ area: "packages/web", q: "  " })).toEqual({});
  });
});

describe("Specs filters in the page", () => {
  async function mount(filter: SpecFilterInput = {}) {
    const changes: SpecFilterInput[] = [];
    const page = mountDom(
      <QueryClientProvider client={new QueryClient()}>
        <Specs
          payload={payload({ specs: SPECS })}
          filter={filter}
          onFilterChange={(next) => changes.push(next)}
        />
      </QueryClientProvider>,
    );
    await act(async () => {});
    return { page, doc: page.container.ownerDocument, changes };
  }

  it("resets the Area when the chosen repository lacks it", async () => {
    const { page, doc, changes } = await mount({ repo: "acme/shop", area: "packages/api" });
    const select = doc.querySelector<HTMLSelectElement>('select[aria-label="Repository"]')!;
    await act(async () => {
      select.value = "acme/blog";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changes.at(-1)).toEqual({ repo: "acme/blog", area: undefined, q: "" });
    page.unmount();
  });

  it("selects the repository with an Area picked under All", async () => {
    const { page, doc, changes } = await mount();
    const select = doc.querySelector<HTMLSelectElement>('select[aria-label="Area"]')!;
    await act(async () => {
      select.value = "acme/shop\npackages/api";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changes.at(-1)).toEqual({ repo: "acme/shop", area: "packages/api", q: "" });
    page.unmount();
  });

  it("narrows on typing and writes the search to the address once typing pauses", async () => {
    const { page, doc, changes } = await mount();
    const input = doc.querySelector<HTMLInputElement>('input[aria-label="Search specs"]')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "posts");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(doc.querySelectorAll("[data-spec]").length).toBe(1);
    expect(changes).toEqual([]);
    await act(async () => new Promise((done) => setTimeout(done, 250)));
    expect(changes.at(-1)).toEqual({ q: "posts" });
    page.unmount();
  });

  it("follows a search the address changes without the field", async () => {
    const changes: SpecFilterInput[] = [];
    const view = (filter: SpecFilterInput) => (
      <QueryClientProvider client={new QueryClient()}>
        <Specs
          payload={payload({ specs: SPECS })}
          filter={filter}
          onFilterChange={(next) => changes.push(next)}
        />
      </QueryClientProvider>
    );
    const page = mountDom(view({ q: "login" }));
    await act(async () => {});
    page.rerender(view({ q: "posts" }));
    await act(async () => {});
    const doc = page.container.ownerDocument;
    expect(doc.querySelector<HTMLInputElement>('input[aria-label="Search specs"]')!.value).toBe(
      "posts",
    );
    expect([...doc.querySelectorAll("[data-spec]")].map((row) => row.textContent)).toEqual([
      expect.stringContaining("acme-posts"),
    ]);
    page.unmount();
  });

  it("clears search and filters from the empty state", async () => {
    const { page, doc, changes } = await mount({ q: "nothing-like-this" });
    const clear = [...doc.querySelectorAll("button")].find(
      (b) => b.textContent === "Clear filters",
    )!;
    await act(async () => clear.click());
    expect(changes.at(-1)).toEqual({});
    page.unmount();
  });
});

type SpecFilterInput = Parameters<NonNullable<Parameters<typeof Specs>[0]["onFilterChange"]>>[0];

describe("Specs panel", () => {
  it("walks only the matching specs", async () => {
    const root = router.createRootRoute();
    const route = router.createRoute({
      getParentRoute: () => root,
      path: "/specs",
      component: () => <Specs payload={payload({ specs: SPECS })} filter={{ repo: "acme/shop" }} />,
    });
    const instance = router.createRouter({
      routeTree: root.addChildren([route]),
      history: router.createMemoryHistory({ initialEntries: ["/specs"] }),
    });
    await instance.load();
    const page = mountDom(
      <QueryClientProvider client={new QueryClient()}>
        <router.RouterProvider router={instance} />
      </QueryClientProvider>,
    );
    await act(async () => {});
    const doc = page.container.ownerDocument;
    await act(async () => doc.querySelector<HTMLButtonElement>("[data-spec]")!.click());
    await act(async () => new Promise((done) => setTimeout(done, 20)));
    const position = () => doc.querySelector('[aria-live="polite"]')?.textContent;
    expect(position()).toBe("1 of 2");
    await act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="Next"]')!.click());
    expect(position()).toBe("2 of 2");
    expect(doc.querySelector<HTMLButtonElement>('[aria-label="Next"]')!.disabled).toBe(true);
    page.unmount();
  });
});

describe("Specs actions", () => {
  describe("skill actions", () => {
    const show = findAction("show-me")!;
    const specs = [spec("acme-login", ["acme/shop", "acme"])];

    /** The spec's panel, opened from its row. */
    async function openSpec(actions: SpecActionOffer[], capability = "acme-login") {
      const root = router.createRootRoute();
      const route = router.createRoute({
        getParentRoute: () => root,
        path: "/specs",
        component: () => (
          <Specs
            payload={payload({ specs: [spec(capability, ["acme/shop", "acme"])] })}
            actions={actions}
          />
        ),
      });
      const instance = router.createRouter({
        routeTree: root.addChildren([route]),
        history: router.createMemoryHistory({ initialEntries: ["/specs"] }),
      });
      await instance.load();
      const page = mountDom(
        <QueryClientProvider client={new QueryClient()}>
          <router.RouterProvider router={instance} />
        </QueryClientProvider>,
      );
      await act(async () => {});
      const doc = page.container.ownerDocument;
      await act(async () => doc.querySelector<HTMLButtonElement>("[data-spec]")!.click());
      await act(async () => new Promise((done) => setTimeout(done, 20)));
      const panel = doc.querySelector('[data-slot="sheet-content"]')!;
      return { page, html: panel.innerHTML, wide: panel.hasAttribute("data-wide") };
    }

    it("opens a spec wide in the panel with Show me and Copy prompt when a terminal and an agent qualify", async () => {
      const { page, html, wide } = await openSpec([
        { action: show, runAgents: ["claude", "opencode"], copyAgents: ["claude", "opencode"] },
      ]);
      expect(wide).toBe(true);
      expect(html).toContain('data-studio-action="show-me"');
      expect(html).toContain('data-studio-subject="acme-login"');
      expect(html).toContain('data-studio-agents="claude opencode"');
      expect(html).toContain("Show me");
      expect(html).toContain('aria-label="Copy prompt"');
      expect(html).toContain('data-prompt-claude="/mate-show-me acme-login"');
      expect(html).toContain("Use the mate-show-me skill on spec acme-login.");
      expect(html).toContain("openspec%2Fspecs%2Facme-login%2Fspec.md");
      page.unmount();
    });

    it("offers copy only without a run agent", async () => {
      const { page, html } = await openSpec([
        { action: show, runAgents: [], copyAgents: ["opencode"] },
      ]);
      expect(html).not.toContain("data-studio-action=");
      expect(html).toContain("data-studio-copy-prompt");
      expect(html).toContain("data-prompt-opencode=");
      expect(html).not.toContain("data-prompt-claude=");
      page.unmount();
    });

    it("offers nothing without offers or for an unsafe capability name", async () => {
      const none = await openSpec([]);
      expect(none.html).not.toContain("data-studio-");
      none.page.unmount();
      const unsafe = await openSpec(
        [{ action: show, runAgents: ["claude"], copyAgents: ["claude"] }],
        '"><b>x',
      );
      expect(unsafe.html).not.toContain("data-studio-");
      unsafe.page.unmount();
    });

    it("keeps the rows free of actions", () => {
      const markup = staticMarkup(
        <Specs
          payload={payload({ specs })}
          actions={[{ action: show, runAgents: ["claude"], copyAgents: ["claude"] }]}
        />,
      );
      expect(markup).not.toContain("data-studio-");
    });
  });
});
