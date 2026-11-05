import { afterEach, describe, expect, it, mock } from "bun:test";
import type { StudioView } from "@uniqbit/mate-core/studio";

import type { ShellCompanion, ShellData } from "../server/shell";

await import("../../test/dom");

/** Companions the fake server deleted. */
const deleted: string[] = [];
mock.module("../server/companions", () => ({
  deleteCompanion: async ({ data }: { data: { companion: string } }) => {
    deleted.push(data.companion);
    return { deletedFolder: true };
  },
}));
const { act, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { staticMarkup } = await import("../../test/render");
const { CompanionPicker, CompanionSwitcher } = await import("./companion-picker");
const { COMPANION_STORAGE_KEY } = await import("./prepaint");
const { Sidebar } = await import("./sidebar");
const { TopBar } = await import("./top-bar");
const { useAppearance } = await import("../stores/appearance");
const { TooltipProvider } = await import("../components/ui/tooltip");

const acme: ShellCompanion = {
  digest: "0123456789",
  path: "/home/dev/.mate/companions/acme-companion",
  note: "",
  unready: false,
  pairings: ["acme/web", "acme/api", "acme/docs", "acme/infra"],
};
const broken: ShellCompanion = {
  digest: "abcdef0123",
  path: "/home/dev/.mate/companions/acme-old",
  note: "folder missing",
  unready: true,
  pairings: [],
};

const shell = (overrides: Partial<ShellData> = {}): ShellData => ({
  companions: [acme, broken],
  selected: acme,
  studioMode: "engineering",
  enabledModes: ["engineering", "analysis"],
  profile: "standard",
  collectedAt: null,
  metrics: null,
  writable: false,
  factoryMode: false,
  terminal: null,
  ...overrides,
});

const sidebar = (data: ShellData, view: StudioView = "dashboard") =>
  staticMarkup(
    <TooltipProvider>
      <Sidebar
        shell={data}
        search={{ companion: acme.digest, studioMode: data.studioMode }}
        view={view}
      />
    </TooltipProvider>,
  );

/** The view links' paths, in order. */
const viewLinks = (markup: string) =>
  [...markup.matchAll(/class="sidebar-nav-link[^"]*"[^>]*href="([^"?]*)/g)].map(
    (match) => match[1],
  );

/** `element` at `path` inside a router whose views are the paths it may navigate to. */
async function mount(element: () => React.ReactNode, path: string) {
  const root = router.createRootRoute({
    component: () => <TooltipProvider>{element()}</TooltipProvider>,
  });
  const routes = ["/", "/workflow", "/vault", "/specs"].map((at) =>
    router.createRoute({ getParentRoute: () => root, path: at, component: () => null }),
  );
  const instance = router.createRouter({
    routeTree: root.addChildren(routes),
    history: router.createMemoryHistory({ initialEntries: [path] }),
  });
  await instance.load();
  const page = render(
    <QueryClientProvider client={new QueryClient()}>
      <router.RouterProvider router={instance} />
    </QueryClientProvider>,
  );
  await act(async () => {});
  return { page, instance, doc: page.container.ownerDocument };
}

const settle = () => act(async () => new Promise((done) => setTimeout(done, 20)));

afterEach(() => {
  document.documentElement.removeAttribute("data-rail");
  useAppearance.setState({ rail: "full" });
});

describe("the companion list page", () => {
  it("lists every companion with its path, pairings and problems", () => {
    const markup = staticMarkup(<CompanionPicker companions={[acme, broken]} />);
    expect(markup).toContain("Choose a Companion Repository");
    expect(markup).toContain(acme.path);
    expect(markup).toContain("acme/web, acme/api, acme/docs +1 more");
    expect(markup).not.toContain("acme/infra");
    expect(markup).toContain("no linked working repository");
    expect(markup).toContain('data-unready="true"');
    expect(markup).toContain("folder missing");
    expect(markup).toContain("mate companion setup");
  });

  it("says how to register one when none is", () => {
    const markup = staticMarkup(<CompanionPicker companions={[]} />);
    expect(markup).toContain("No Companion Repository is registered on this machine.");
    expect(markup).toContain("mate companion setup");
  });
});

describe("the companion switcher", () => {
  it("names the selected companion in the top bar", () => {
    const markup = staticMarkup(<CompanionSwitcher companions={[acme, broken]} selected={acme} />);
    expect(markup).toContain('aria-label="Companion Repository: acme-companion"');
    expect(markup).toContain("acme-companion");
  });

  it("lists every companion, de-emphasizes one not ready, and selects another", async () => {
    const { doc, instance } = await mount(
      () => <CompanionSwitcher companions={[acme, broken]} selected={acme} />,
      `/?companion=${acme.digest}`,
    );
    await act(async () => doc.querySelector<HTMLButtonElement>("#studio-companion")!.click());
    await settle();
    const rows = [...doc.querySelectorAll<HTMLButtonElement>(".picker-card")];
    expect(rows.map((row) => row.querySelector(".picker-card-name")?.textContent)).toEqual([
      "acme-companion",
      "acme-old",
    ]);
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    expect(rows[1]!.getAttribute("data-unready")).toBe("true");
    expect(rows[1]!.textContent).toContain("folder missing");
    await act(async () => rows[1]!.click());
    await settle();
    expect(instance.state.location.search).toMatchObject({ companion: broken.digest });
  });

  it("closes on Escape and keeps the selection", async () => {
    const { doc, instance } = await mount(
      () => <CompanionSwitcher companions={[acme, broken]} selected={acme} />,
      `/?companion=${acme.digest}`,
    );
    await act(async () => doc.querySelector<HTMLButtonElement>("#studio-companion")!.click());
    await settle();
    expect(doc.querySelector(".picker-card")).not.toBeNull();
    await act(async () => {
      doc.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();
    expect(doc.querySelector('[data-slot="popover-content"]')?.getAttribute("data-open")).not.toBe(
      "",
    );
    expect(instance.state.location.search).toMatchObject({ companion: acme.digest });
  });

  it("offers Copy path and a delete that waits for the companion's name", async () => {
    const { doc } = await mount(
      () => <CompanionPicker companions={[acme, { ...broken, missing: true }]} writable />,
      "/",
    );
    await act(async () =>
      doc.querySelector<HTMLButtonElement>('[aria-label="Actions for acme-companion"]')!.click(),
    );
    await settle();
    const items = () => [
      ...doc.querySelectorAll<HTMLButtonElement>('[data-slot="popover-content"] button'),
    ];
    expect(items().map((item) => item.textContent)).toEqual(["Copy path", "Delete companion…"]);
    await act(async () => items()[1]!.click());
    await settle();
    const dialog = doc.querySelector('[data-slot="dialog-content"]')!;
    expect(dialog.textContent).toContain("It cannot be undone.");
    const confirm = () =>
      [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Delete companion")!;
    expect(confirm().disabled).toBe(true);
    const field = dialog.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(field, "acme-companion");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(confirm().disabled).toBe(false);
  });

  it("starts the next delete untyped and forgets the deleted companion", async () => {
    const twin: ShellCompanion = { ...acme, digest: "0123456780", path: "/srv/acme-companion" };
    localStorage.setItem(COMPANION_STORAGE_KEY, acme.digest);
    const { doc } = await mount(() => <CompanionPicker companions={[acme, twin]} writable />, "/");
    const openDelete = async (index: number) => {
      const actions = doc.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Actions for acme-companion"]',
      );
      await act(async () => actions[index]!.click());
      await settle();
      const remove = [
        ...doc.querySelectorAll<HTMLButtonElement>('[data-slot="popover-content"] button'),
      ].find((item) => item.textContent === "Delete companion…")!;
      await act(async () => remove.click());
      await settle();
      return doc.querySelector('[data-slot="dialog-content"]')!;
    };
    let dialog = await openDelete(0);
    const field = dialog.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(field, "acme-companion");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const confirm = () =>
      [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Delete companion")!;
    await act(async () => confirm().click());
    await settle();
    expect(deleted).toEqual([acme.digest]);
    expect(localStorage.getItem(COMPANION_STORAGE_KEY)).toBeNull();
    dialog = await openDelete(1);
    expect(dialog.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(confirm().disabled).toBe(true);
  });

  it("offers only removal from the list for a companion whose folder is gone, and no delete when read-only", async () => {
    const { doc } = await mount(
      () => <CompanionPicker companions={[{ ...broken, missing: true }]} />,
      "/",
    );
    await act(async () =>
      doc.querySelector<HTMLButtonElement>('[aria-label="Actions for acme-old"]')!.click(),
    );
    await settle();
    const remove = [
      ...doc.querySelectorAll<HTMLButtonElement>('[data-slot="popover-content"] button'),
    ].find((item) => item.textContent === "Remove from list…")!;
    expect(remove.disabled).toBe(true);
    expect(doc.body.textContent).toContain("Start Studio with --writable to delete.");
  });
});

describe("the sidebar", () => {
  it("offers Engineering's views, then the library, in order", () => {
    const markup = sidebar(shell());
    expect(viewLinks(markup)).toEqual([
      "/",
      "/workflow",
      "/skills",
      "/specs",
      "/vault",
      "/reports",
    ]);
    expect(markup).toContain('data-studio-nav-section="Engineering"');
    expect(markup).toContain('data-studio-nav-section="Library"');
  });

  it("offers Factory after Workflow only where the factory broker runs", () => {
    expect(viewLinks(sidebar(shell()))).not.toContain("/factory");
    expect(viewLinks(sidebar(shell({ factoryMode: true })))).toEqual([
      "/",
      "/workflow",
      "/factory",
      "/skills",
      "/specs",
      "/vault",
      "/reports",
    ]);
  });

  it("gives Analysis its Overview and the published views, and no Workflow, Skills or Factory", () => {
    const markup = sidebar(shell({ studioMode: "analysis", factoryMode: true }));
    expect(viewLinks(markup)).toEqual(["/", "/specs", "/vault", "/reports"]);
    expect(markup).toContain('data-studio-nav-section="Analysis"');
    expect(markup).toContain('data-studio-nav-section="Published"');
  });

  it("keeps companion and mode in every view link, and marks the current view", () => {
    const markup = sidebar(shell({ studioMode: "analysis" }), "specs");
    const links = [...markup.matchAll(/class="sidebar-nav-link[^"]*"[^>]*href="([^"]*)"/g)].map(
      (match) => new URL(match[1]!.replaceAll("&amp;", "&"), "http://localhost"),
    );
    expect(links.length).toBeGreaterThan(2);
    for (const link of links) {
      expect(link.searchParams.get("companion")).toBe(acme.digest);
      expect(link.searchParams.get("studioMode")).toBe("analysis");
    }
    expect(markup).toMatch(/aria-current="page"[^>]*>(?:(?!<\/a>).)*Specs/);
  });

  it("collapses to icons with Cmd or Ctrl and Backslash, and remembers it", async () => {
    const { doc } = await mount(
      () => <Sidebar shell={shell()} search={{ companion: acme.digest }} view="dashboard" />,
      `/?companion=${acme.digest}`,
    );
    const toggle = doc.querySelector<HTMLButtonElement>("#studio-rail-toggle")!;
    expect(toggle.getAttribute("aria-label")).toBe("Collapse sidebar");
    await act(async () => toggle.click());
    expect(doc.documentElement.getAttribute("data-rail")).toBe("min");
    expect(localStorage.getItem("mate-studio-rail")).toBe("min");
    expect(
      doc.querySelector<HTMLButtonElement>("#studio-rail-toggle")!.getAttribute("aria-label"),
    ).toBe("Expand sidebar");
    // Collapsed, each view keeps its name for assistive technology.
    const links = [...doc.querySelectorAll(".sidebar-nav-link")];
    expect(links.map((link) => link.getAttribute("aria-label"))).toContain("Workflow");
  });
});

/** The Mode segments: label, pressed and disabled, in order. */
function segments(doc: Document) {
  return [...doc.querySelectorAll<HTMLButtonElement>('[aria-label="Mode"] button')].map(
    (button) => ({
      button,
      label: button.textContent,
      pressed: button.getAttribute("aria-pressed"),
      disabled: button.disabled,
    }),
  );
}

describe("the Mode switch", () => {
  it("sits in the sidebar footer, named Mode, marking the effective mode", async () => {
    const { doc } = await mount(
      () => (
        <Sidebar
          shell={shell({ studioMode: "analysis" })}
          search={{ companion: acme.digest, studioMode: "analysis" }}
          view="dashboard"
        />
      ),
      "/",
    );
    expect(doc.querySelector('.sidebar-footer [role="group"][aria-label="Mode"]')).not.toBeNull();
    const [engineering, analysis] = segments(doc);
    expect([engineering?.label, analysis?.label]).toEqual(["Engineering", "Analysis"]);
    expect(engineering?.pressed).toBe("false");
    expect(analysis?.pressed).toBe("true");
  });

  it("keeps a shared view and lands on the Overview from one the other mode lacks", async () => {
    for (const [view, path, landing] of [
      ["vault", "/vault", "/vault"],
      ["workflow", "/workflow", "/"],
    ] as const) {
      const { doc, instance, page } = await mount(
        () => (
          <Sidebar
            shell={shell()}
            search={{ companion: acme.digest, studioMode: "engineering" }}
            view={view}
          />
        ),
        `${path}?companion=${acme.digest}&studioMode=engineering`,
      );
      await act(async () => segments(doc)[1]!.button.click());
      await settle();
      expect(instance.state.location.pathname).toBe(landing);
      expect(instance.state.location.search).toMatchObject({
        companion: acme.digest,
        studioMode: "analysis",
      });
      page.unmount();
    }
  });

  it("shows appliance Engineering disabled and says why", async () => {
    const { doc, instance } = await mount(
      () => (
        <Sidebar
          shell={shell({
            studioMode: "analysis",
            enabledModes: ["analysis"],
            profile: "appliance",
          })}
          search={{ companion: acme.digest, studioMode: "analysis" }}
          view="dashboard"
        />
      ),
      "/",
    );
    const [engineering] = segments(doc);
    expect(engineering?.disabled).toBe(true);
    expect(engineering?.button.getAttribute("aria-describedby")).toBe("studio-mode-note");
    expect(doc.getElementById("studio-mode-note")?.textContent).toBe(
      "Engineering is unavailable in the appliance.",
    );
    await act(async () => engineering!.button.click());
    expect(instance.state.location.pathname).toBe("/");
  });
});

describe("the top bar", () => {
  it("offers the switcher, the palette, then the snapshot time, refresh and appearance", () => {
    const at = Date.UTC(2026, 10, 3, 9, 30, 15);
    const markup = staticMarkup(
      <TooltipProvider>
        <TopBar shell={shell({ collectedAt: at })} search={{ companion: acme.digest }} />
      </TooltipProvider>,
    );
    const order = ["studio-companion", "studio-palette-open", "studio-refresh", "studio-theme"].map(
      (id) => markup.indexOf(`id="${id}"`),
    );
    expect(order.every((index) => index !== -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The clock time is left to the browser, whose time zone may differ from the server's.
    expect(markup).toContain(`<time dateTime="${new Date(at).toISOString()}"></time>`);
  });

  it("offers the terminal control only with the terminal", () => {
    const terminal = { pinned: false, target: null, agents: [] };
    const without = staticMarkup(
      <TooltipProvider>
        <TopBar shell={shell()} search={{}} />
      </TooltipProvider>,
    );
    const withTerminal = staticMarkup(
      <TooltipProvider>
        <TopBar shell={shell({ terminal })} search={{}} />
      </TooltipProvider>,
    );
    expect(without).not.toContain('id="terminal-drawer-open"');
    expect(withTerminal).toContain('id="terminal-drawer-open"');
  });
});
