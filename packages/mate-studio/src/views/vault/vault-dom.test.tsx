import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { VaultView } from "@uniqbit/mate-core/studio";

await import("../../../test/dom");

/** Calls the page made, and what the fake server answers next. */
const server = {
  saves: [] as { path: string; content: string; token?: string }[],
  saveResult: { kind: "saved", path: "acme/notes.md", token: "acme-token-2" } as unknown,
  children: [] as string[],
};

mock.module("../../server/vault", () => ({
  getVault: async () => view(),
  getVaultChildren: async ({ data }: { data: { dir: string } }) => {
    server.children.push(data.dir);
    return {
      entries: [{ name: "deep.md", path: `${data.dir}/deep.md`, kind: "file" }],
      generation: 3,
    };
  },
  getVaultMatches: async () => ({ shown: [], total: 0, generation: 3 }),
  saveVaultFile: async ({ data }: { data: { path: string; content: string; token?: string } }) => {
    server.saves.push(data);
    return server.saveResult;
  },
}));

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  close() {
    this.closed = true;
  }
  emit(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}
(globalThis as { EventSource: unknown }).EventSource = FakeEventSource;

const { act, fireEvent, render, waitFor } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { VaultLayout } = await import("./vault-view");
const { useVaultUi } = await import("../../stores/vault-ui");

function view(overrides: Partial<VaultView> = {}): VaultView {
  return {
    tree: [
      {
        name: "acme",
        path: "acme",
        kind: "directory",
        children: [{ name: "notes.md", path: "acme/notes.md", kind: "file" }],
      },
      { name: "docs", path: "docs", kind: "directory" },
    ],
    generation: 3,
    watching: true,
    warning: null,
    failure: null,
    dir: null,
    dirMissing: false,
    open: {
      path: "acme/notes.md",
      content: "# Notes",
      token: "acme-token",
      markdown: [
        { t: "h1", c: ["Notes"] },
        { t: "p", c: [{ t: "a", a: { note: "docs/x.md" }, c: ["x"] }, "<script>"] },
      ],
    },
    refusal: null,
    ...overrides,
  };
}

async function mount(initial: string) {
  const root = router.createRootRoute({
    validateSearch: (raw: { companion?: unknown }) => ({ companion: String(raw.companion ?? "") }),
  });
  const route = router.createRoute({
    getParentRoute: () => root,
    path: "/vault",
    validateSearch: (raw: { path?: unknown; dir?: unknown; mode?: unknown }) => ({
      ...(typeof raw.path === "string" ? { path: raw.path } : {}),
      ...(typeof raw.dir === "string" ? { dir: raw.dir } : {}),
      ...(raw.mode === "edit" ? { mode: "edit" as const } : {}),
    }),
    component: function Vault() {
      const search = route.useSearch();
      return (
        <VaultLayout companion="0123456789" rootName="acme-companion" writable search={search} />
      );
    },
  });
  const app = router.createRouter({
    routeTree: root.addChildren([route]),
    history: router.createMemoryHistory({ initialEntries: [initial] }),
  });
  await app.load();
  const result = render(
    <QueryClientProvider client={new QueryClient()}>
      <router.RouterProvider router={app} />
    </QueryClientProvider>,
  );
  const doc = result.container.ownerDocument;
  await waitFor(() => {
    if (!doc.querySelector("[data-vault-layout]")) throw new Error("the vault has not rendered");
  });
  return { ...result, app, doc };
}

beforeEach(() => {
  server.saves = [];
  server.children = [];
  server.saveResult = { kind: "saved", path: "acme/notes.md", token: "acme-token-2" };
  useVaultUi.setState({ latestGeneration: null, dirty: false, treeHidden: false });
});

describe("the vault in a browser", () => {
  it("renders a file from server data, links opening notes in the vault and markup as text", async () => {
    const { doc, unmount } = await mount("/vault?companion=0123456789&path=acme/notes.md");
    const link = doc.querySelector<HTMLAnchorElement>(
      '.markdown-body a[data-vault-entry="docs/x.md"]',
    )!;
    expect(link.getAttribute("href")).toContain("path=docs%2Fx.md");
    expect(doc.querySelector(".markdown-body script")).toBeNull();
    expect(doc.querySelector(".markdown-body")!.textContent).toContain("<script>");
    unmount();
  });

  it("saves with the token it opened, then returns to read", async () => {
    const { doc, app, unmount } = await mount(
      "/vault?companion=0123456789&path=acme/notes.md&mode=edit",
    );
    const editor = doc.querySelector<HTMLTextAreaElement>("#vault-editor")!;
    fireEvent.change(editor, { target: { value: "# Notes, edited" } });
    await act(async () => doc.querySelector<HTMLButtonElement>("#vault-save")!.click());
    await waitFor(() => expect(app.state.location.search).not.toHaveProperty("mode"));
    expect(server.saves).toEqual([
      {
        companion: "0123456789",
        path: "acme/notes.md",
        content: "# Notes, edited",
        token: "acme-token",
      } as never,
    ]);
    expect(app.state.location.search).not.toHaveProperty("mode");
    unmount();
  });

  it("keeps the unsaved text when a save is refused, offering the current version", async () => {
    server.saveResult = {
      kind: "conflict",
      path: "acme/notes.md",
      reason: "the file changed since it was opened",
      content: "# Theirs",
      token: "acme-token-3",
    };
    const { doc, app, unmount } = await mount(
      "/vault?companion=0123456789&path=acme/notes.md&mode=edit",
    );
    fireEvent.change(doc.querySelector("#vault-editor")!, { target: { value: "# Mine" } });
    await act(async () => doc.querySelector<HTMLButtonElement>("#vault-save")!.click());
    expect(doc.querySelector<HTMLTextAreaElement>("#vault-editor")!.value).toBe("# Mine");
    expect(doc.querySelector("#vault-incoming-content")!.textContent).toBe("# Theirs");
    expect(doc.querySelector("#vault-status")!.textContent).toBe(
      "the file changed since it was opened",
    );
    expect(app.state.location.search).toHaveProperty("mode", "edit");
    unmount();
  });

  it("follows the file on disk, keeping unsaved text and offering the new version instead", async () => {
    const { doc, unmount } = await mount(
      "/vault?companion=0123456789&path=acme/notes.md&mode=edit",
    );
    await act(async () =>
      FakeEventSource.last!.emit({ kind: "changed", content: "# From disk", token: "t2" }),
    );
    expect(doc.querySelector<HTMLTextAreaElement>("#vault-editor")!.value).toBe("# From disk");
    fireEvent.change(doc.querySelector("#vault-editor")!, { target: { value: "# Mine" } });
    await act(async () =>
      FakeEventSource.last!.emit({ kind: "changed", content: "# Agent", token: "t3" }),
    );
    expect(doc.querySelector<HTMLTextAreaElement>("#vault-editor")!.value).toBe("# Mine");
    expect(doc.querySelector("#vault-incoming-content")!.textContent).toBe("# Agent");
    await act(async () => FakeEventSource.last!.emit({ kind: "removed" }));
    expect(doc.querySelector("#vault-status")!.textContent).toBe(
      "this file no longer exists on disk",
    );
    unmount();
  });

  it("asks before leaving unsaved text, and stays when declined", async () => {
    const { doc, app, unmount } = await mount(
      "/vault?companion=0123456789&path=acme/notes.md&mode=edit",
    );
    fireEvent.change(doc.querySelector("#vault-editor")!, { target: { value: "# Unsaved" } });
    const asked: string[] = [];
    window.confirm = (message?: string) => {
      asked.push(String(message));
      return false;
    };
    // A blocked navigation never settles, so it is not awaited.
    await act(async () => {
      void app.navigate({
        to: "/vault",
        search: { companion: "0123456789", path: "acme/other.md" } as never,
      });
    });
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked).toEqual(["Discard unsaved changes?"]);
    expect(app.state.location.search).toHaveProperty("path", "acme/notes.md");
    unmount();
  });

  it("asks for a collapsed folder's entries only when it is first opened", async () => {
    const { doc, unmount } = await mount("/vault?companion=0123456789");
    expect(server.children).toEqual([]);
    const docs = doc.querySelector<HTMLDetailsElement>('details[data-vault-dir="docs"]')!;
    docs.open = true;
    await act(async () => fireEvent(docs, new Event("toggle")));
    await waitFor(() =>
      expect(docs.querySelector('[data-vault-entry="docs/deep.md"]')).not.toBeNull(),
    );
    expect(server.children).toEqual(["docs"]);
    unmount();
  });

  it("says the tree is stale when the watch reports a newer listing", async () => {
    const { doc, unmount } = await mount("/vault?companion=0123456789");
    expect(doc.querySelector<HTMLElement>("#vault-stale")!.hidden).toBe(true);
    await act(async () => useVaultUi.getState().setGeneration(4));
    expect(doc.querySelector<HTMLElement>("#vault-stale")!.hidden).toBe(false);
    unmount();
  });

  it("hides the tree and remembers the choice", async () => {
    const { doc, unmount } = await mount("/vault?companion=0123456789");
    await act(async () => doc.querySelector<HTMLButtonElement>("#vault-tree-toggle")!.click());
    expect(doc.documentElement.getAttribute("data-vault-tree")).toBe("hidden");
    expect(localStorage.getItem("mate-studio-vault-tree")).toBe("hidden");
    expect(doc.querySelector("#vault-tree-toggle")!.textContent).toBe("Show files");
    unmount();
  });
});
