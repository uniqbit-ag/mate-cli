import { afterEach, describe, expect, it } from "bun:test";
import type { StudioMode } from "@uniqbit/mate-core/studio";

import type { CompanionViewData } from "../server/views";
import type { ShellData } from "../server/shell";

await import("../../test/dom");
const { act, fireEvent, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { CommandPalette } = await import("./command-palette");
const { companionViewQuery } = await import("../lib/studio-queries");
const { usePalette } = await import("../stores/palette");

const acme = {
  digest: "0123456789",
  path: "/home/dev/.mate/companions/acme-companion",
  note: "",
  unready: false,
  pairings: [],
};

const shell = (studioMode: StudioMode): ShellData => ({
  companions: [acme],
  selected: acme,
  studioMode,
  enabledModes: ["engineering", "analysis"],
  profile: "standard",
  collectedAt: null,
  metrics: null,
  writable: false,
  factoryMode: true,
  terminal: null,
});

afterEach(() => usePalette.setState({ open: false }));

async function mount(studioMode: StudioMode = "engineering") {
  const search = { companion: acme.digest, studioMode };
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(companionViewQuery("dashboard", search).queryKey, {
    error: null,
    studioMode,
    changes: [
      { name: "archive-spec-drift-check", completedTasks: 0, totalTasks: 13, artifacts: [] },
      { name: "acme-build", completedTasks: 2, totalTasks: 5, artifacts: [] },
    ],
    warnings: [],
  } satisfies CompanionViewData);
  const root = router.createRootRoute({
    component: () => <CommandPalette shell={shell(studioMode)} search={search} />,
  });
  const routes = ["/", "/workflow", "/specs"].map((path) =>
    router.createRoute({
      getParentRoute: () => root,
      path,
      validateSearch: (raw: Record<string, unknown>) => raw,
      component: () => null,
    }),
  );
  const instance = router.createRouter({
    routeTree: root.addChildren(routes),
    history: router.createMemoryHistory({ initialEntries: ["/specs"] }),
  });
  await instance.load();
  const page = render(
    <QueryClientProvider client={queryClient}>
      <router.RouterProvider router={instance} />
    </QueryClientProvider>,
  );
  await act(async () => {});
  return { page, instance, doc: page.container.ownerDocument };
}

const settle = () => act(async () => new Promise((done) => setTimeout(done, 30)));

const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });

const options = (doc: Document) =>
  [...doc.querySelectorAll('#studio-palette [role="option"]')].map((option) => option.textContent);

async function open(doc: Document) {
  await press(doc.body, "k", { metaKey: true });
  await settle();
  return doc.querySelector<HTMLInputElement>("#studio-palette input")!;
}

describe("the command palette", () => {
  it("opens on Cmd+K with its field focused", async () => {
    const { page, doc } = await mount();
    const input = await open(doc);
    expect(doc.activeElement).toBe(input);
    page.unmount();
  });

  it("opens on Slash outside a text field", async () => {
    const { page, doc } = await mount();
    await press(doc.body, "/");
    await settle();
    expect(doc.querySelector("#studio-palette")).not.toBeNull();
    page.unmount();
  });

  it("leaves a Slash the page already took, such as the Factory filter", async () => {
    const { page, doc } = await mount();
    const take = (event: Event) => event.preventDefault();
    window.addEventListener("keydown", take, true);
    await press(doc.body, "/", { cancelable: true });
    await settle();
    window.removeEventListener("keydown", take, true);
    expect(doc.querySelector("#studio-palette")).toBeNull();
    page.unmount();
  });

  it("offers views, changes, next steps and actions", async () => {
    const { page, doc } = await mount();
    await open(doc);
    const listed = options(doc).join(" | ");
    for (const entry of [
      "Overview",
      "Workflow",
      "Factory",
      "archive-spec-drift-check",
      "Copy next step: /mate-apply-change archive-spec-drift-check",
      "Refresh",
      "Switch appearance",
    ]) {
      expect(listed).toContain(entry);
    }
    page.unmount();
  });

  it("jumps to a change's panel on the Overview", async () => {
    const { page, doc, instance } = await mount();
    const input = await open(doc);
    await act(async () => fireEvent.change(input, { target: { value: "arch" } }));
    await settle();
    const change = [...doc.querySelectorAll<HTMLElement>('#studio-palette [role="option"]')].find(
      (option) => option.textContent?.startsWith("archive-spec-drift-check"),
    )!;
    await act(async () => change.click());
    await settle();
    expect(instance.state.location.pathname).toBe("/");
    expect(instance.state.location.search).toMatchObject({ change: "archive-spec-drift-check" });
    expect(usePalette.getState().open).toBe(false);
    page.unmount();
  });

  it("says when nothing matches", async () => {
    const { page, doc } = await mount();
    const input = await open(doc);
    await act(async () => fireEvent.change(input, { target: { value: "zzzz-nothing" } }));
    await settle();
    expect(doc.querySelector("#studio-palette")?.textContent).toContain("Nothing matches.");
    page.unmount();
  });

  it("offers no Workflow, Skills or Factory in Analysis", async () => {
    const { page, doc } = await mount("analysis");
    await open(doc);
    const listed = options(doc);
    expect(listed.some((entry) => /^(Workflow|Skills|Factory)View$/.test(entry ?? ""))).toBe(false);
    expect(listed.some((entry) => entry?.startsWith("Overview"))).toBe(true);
    page.unmount();
  });
});
