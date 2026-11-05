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
const { groupSpecsByArea } = await import("./spec-areas");
const { Specs } = await import("./specs-view");

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
  it("presents one card per Area, and none of the Dashboard's changes", () => {
    const markup = staticMarkup(
      <Specs
        payload={payload({
          changes: [{ name: "add-auth", artifacts: [] }],
          specs: [
            { capability: "acme-login", areas: ["acme"], requirementCount: 3 },
            { capability: "acme-search", areas: ["docs"], valid: false, issueCount: 2 },
          ],
        })}
      />,
    );
    expect(markup).toContain('aria-label="Specs by Area"');
    expect(markup).toContain('<section class="list-card');
    expect(markup).toContain('aria-label="Area acme"');
    expect(markup).toContain('aria-label="Area docs"');
    expect(markup).toMatch(
      /<h2[^>]*><span class="font-mono">acme<\/span><\/h2><span[^>]*>1<\/span>/,
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
      <Specs payload={payload({ specs: [{ capability: "c", areas: ["<i>a</i>"] }] })} />,
    );
    expect(markup).not.toContain("<i>a</i>");
    expect(markup).toContain("&lt;i&gt;a&lt;/i&gt;");
  });
});

describe("groupSpecsByArea", () => {
  it("lists a spec under every Area it binds, ordered by Area", () => {
    const groups = groupSpecsByArea([
      { capability: "acme-login", areas: ["packages/core", "apps/web"] },
      { capability: "acme-search", areas: ["apps/web"] },
    ]);
    expect(groups.map(([area]) => area)).toEqual(["apps/web", "packages/core"]);
    expect(groups[0]![1].map((spec) => spec.capability)).toEqual(["acme-login", "acme-search"]);
  });

  it("groups a spec binding no Area as unassigned", () => {
    expect(groupSpecsByArea([{ capability: "acme-login", areas: [] }])[0]![0]).toBe("unassigned");
  });

  describe("skill actions", () => {
    const show = findAction("show-me")!;
    const specs = [{ capability: "acme-login", areas: ["acme"] }];

    /** The spec's panel, opened from its row. */
    async function openSpec(actions: SpecActionOffer[], capability = "acme-login") {
      const root = router.createRootRoute();
      const route = router.createRoute({
        getParentRoute: () => root,
        path: "/specs",
        component: () => (
          <Specs
            payload={payload({ specs: [{ capability, areas: ["acme"] }] })}
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
