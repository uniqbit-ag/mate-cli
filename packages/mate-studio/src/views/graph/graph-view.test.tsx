import { describe, expect, it, mock } from "bun:test";
import type { StudioSpecGraph } from "@uniqbit/mate-core/studio";

await import("../../../test/dom");

/** The WebGL canvas cannot run here; the stub records that the renderer was asked for. */
let rendererLoads = 0;
mock.module("./graph-canvas", () => {
  rendererLoads += 1;
  return { default: () => <div data-canvas-stub /> };
});

const { act, render: mountDom } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { staticMarkup } = await import("../../../test/render");
const { graphQuery } = await import("../../lib/studio-queries");
const { fixture } = await import("./fixture");
const { indexNodes } = await import("./model");
const { GraphPanelBody } = await import("./graph-panel");
const { GraphView } = await import("./graph-view");

const companion = "0123456789";
const search = { companion, studioMode: "engineering" as const };

function panel(selection: { node: string } | { edge: number }, wire = fixture()) {
  return staticMarkup(
    <GraphPanelBody
      selection={selection}
      wire={wire}
      index={indexNodes(wire)}
      search={search}
      onSelectNode={() => {}}
    />,
  );
}

const vaultHrefs = (markup: string) =>
  [...markup.matchAll(/href="\/vault\?([^"]*)"/g)].map((match) =>
    new URLSearchParams(match[1]!.replaceAll("&amp;", "&")).get("path"),
  );

describe("the Graph panel", () => {
  it("shows a spec's History newest first, linking only its existing artifacts", () => {
    const markup = panel({ node: "spec:acme-auth" });
    expect(markup).toContain('aria-label="History"');
    expect([...markup.matchAll(/data-archive="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "2026-03-01-new",
      "2026-01-01-old",
    ]);
    expect(vaultHrefs(markup)).toEqual([
      "openspec/specs/acme-auth/spec.md",
      "openspec/changes/archive/2026-03-01-new/tasks.md",
      "openspec/changes/archive/2026-03-01-new/specs/acme-auth/spec.md",
      "openspec/changes/archive/2026-01-01-old/proposal.md",
      "openspec/changes/archive/2026-01-01-old/tasks.md",
      "openspec/changes/archive/2026-01-01-old/specs/acme-auth/spec.md",
    ]);
    expect(markup).not.toContain("design.md");
    expect(markup).toContain("packages/acme");
  });

  it("lists an Area's capabilities, selectable", () => {
    const markup = panel({ node: "area:acme/web#packages/acme" });
    expect([...markup.matchAll(/data-graph-node="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "spec:acme-auth",
      "spec:acme-session",
    ]);
    expect(markup).toContain("acme/web");
  });

  it("lists a repository's Areas with their capabilities", () => {
    const markup = panel({ node: "repo:acme/web" });
    expect(markup).toContain('aria-label="packages/acme"');
    expect(markup).toContain('data-graph-node="spec:acme-session"');
  });

  it("lists the archives behind a co-change edge", () => {
    const markup = panel({ edge: 4 });
    expect(markup).toContain("2 shared archived changes");
    expect([...markup.matchAll(/data-archive="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "2026-03-01-new",
      "2026-01-01-old",
    ]);
    expect(vaultHrefs(markup)).toContain(
      "openspec/changes/archive/2026-01-01-old/specs/acme-session/spec.md",
    );
  });

  it("shows a mention's source and target", () => {
    const markup = panel({ edge: 3 });
    expect(markup).toMatch(/acme-auth<\/button>.*→.*acme-session<\/button>/);
    expect(markup).not.toContain('aria-label="Archived changes"');
  });

  it("shows nothing for a node the graph does not have", () => {
    expect(panel({ node: "spec:acme-gone" })).toBe("");
  });
});

describe("the Graph view", () => {
  async function mount(wire: StudioSpecGraph, node?: string) {
    // Held data only: there is no server runtime to refetch from.
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    client.setQueryData(graphQuery(companion).queryKey, wire);
    const changes: (string | undefined)[] = [];
    const { RouterContextProvider, createRootRoute, createRouter, createMemoryHistory } =
      await import("@tanstack/react-router");
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ["/graph"] }),
    });
    await router.load();
    const page = mountDom(
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <GraphView search={search} node={node} onNodeChange={(next) => changes.push(next)} />
        </RouterContextProvider>
      </QueryClientProvider>,
    );
    await act(async () => new Promise((done) => setTimeout(done, 10)));
    return { page, changes, doc: page.container.ownerDocument };
  }

  it("shows an empty note and loads no renderer when there are no specs", async () => {
    const before = rendererLoads;
    const { page } = await mount({ ...fixture(), nodes: [], edges: [], history: [], unbound: [] });
    expect(page.container.textContent).toContain("No specs in this companion.");
    expect(page.container.querySelector("[data-canvas-stub]")).toBeNull();
    expect(rendererLoads).toBe(before);
    page.unmount();
  });

  it("selects nothing for an unknown node and reports unbound specs", async () => {
    const { page, doc } = await mount(fixture(), "spec:acme-gone");
    expect(doc.querySelector("[data-canvas-stub]")).not.toBeNull();
    expect(doc.querySelector("[data-slot=sheet-content]")).toBeNull();
    expect(doc.querySelector("[data-graph-problems]")?.textContent).toContain("1 unbound spec");
    page.unmount();
  });

  it("focuses and selects the first search match", async () => {
    const { page, doc, changes } = await mount(fixture());
    const input = doc.querySelector<HTMLInputElement>("[data-graph-search]")!;
    const { fireEvent } = await import("@testing-library/react");
    await act(async () => {
      fireEvent.change(input, { target: { value: "session" } });
    });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });
    expect(changes).toEqual(["spec:acme-session"]);
    page.unmount();
  });

  it("opens the panel for a selected capability", async () => {
    const { page, doc } = await mount(fixture(), "spec:acme-auth");
    expect(doc.querySelector('[aria-label="Spec acme-auth"]')).not.toBeNull();
    expect(doc.body.textContent).toContain("History");
    page.unmount();
  });
});
