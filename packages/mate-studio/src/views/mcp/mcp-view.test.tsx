import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
  McpManagerPreview,
  McpManagerSaveResult,
  McpManagerState,
  McpManagerView,
} from "@uniqbit/mate-core/studio";

await import("../../../test/dom");
const { act, cleanup, fireEvent, render, screen, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");

const view: McpManagerView = {
  catalog: {
    servers: {
      "acme-docs": { command: "acme-docs-mcp", env: ["ACME_TOKEN"] },
      "acme-db": { command: "acme-db-mcp" },
    },
    groups: { "acme-data": ["acme-db"] },
    enabled: { servers: ["acme-db"] },
  },
  audiences: { analyst: {} },
  effective: { base: ["acme-db"], audiences: { analyst: ["acme-db"] } },
  variables: { "acme-docs": [{ name: "ACME_TOKEN", set: false }], "acme-db": [] },
  token: "a".repeat(64),
};

interface SaveInput {
  companion: string;
  next: McpManagerState;
  token: string;
}

const accepted: McpManagerPreview = {
  ok: true,
  effective: view.effective,
  variables: view.variables,
};
const server = {
  read: async (): Promise<McpManagerView> => view,
  saves: [] as SaveInput[],
  preview: (_next: McpManagerState): McpManagerPreview => accepted,
  save: (_input: SaveInput): McpManagerSaveResult => ({ kind: "saved", view }),
};
const real = await import("../../server/mcp-manager");
mock.module("../../server/mcp-manager", () => ({
  ...real,
  getMcpManager: () => server.read(),
  previewMcpManager: async ({ data }: { data: { next: McpManagerState } }) =>
    server.preview(data.next),
  saveMcpManager: async ({ data }: { data: SaveInput }) => {
    server.saves.push(data);
    return server.save(data);
  },
}));
const { Mcp } = await import("./mcp-view");

const confirm = window.confirm;

afterEach(() => {
  cleanup();
  window.confirm = confirm;
  server.read = async () => view;
  server.saves = [];
  server.preview = () => accepted;
  server.save = () => ({ kind: "saved", view });
});

const settle = () => act(async () => new Promise((done) => setTimeout(done, 20)));

async function mount(writable = true) {
  const root = router.createRootRoute();
  const route = router.createRoute({
    getParentRoute: () => root,
    path: "/mcp",
    component: () => <Mcp companion="0123456789" writable={writable} />,
  });
  const other = router.createRoute({ getParentRoute: () => root, path: "/skills" });
  const app = router.createRouter({
    routeTree: root.addChildren([route, other]),
    history: router.createMemoryHistory({ initialEntries: ["/mcp"] }),
  });
  await app.load();
  const page = render(
    <QueryClientProvider client={new QueryClient()}>
      <router.RouterProvider router={app} />
    </QueryClientProvider>,
  );
  await settle();
  const cell = (id: string) =>
    page.container.querySelector<HTMLButtonElement>(`[data-mcp-cell="${id}"]`)!;
  const press = async (button: HTMLElement) => {
    fireEvent.click(button);
    await settle();
  };
  return { page, cell, press, app };
}

describe("Mcp", () => {
  test("a successful Retry moves focus to Add server", async () => {
    server.read = async () => {
      throw new Error("framework.yaml is invalid");
    };
    const { page, press } = await mount();
    server.read = async () => view;
    await press(page.getByRole("button", { name: "Retry" }));
    expect(document.activeElement).toBe(page.getByRole("button", { name: "Add server" }));
  });

  test("a successful Retry in a read-only Studio moves focus to the filter", async () => {
    server.read = async () => {
      throw new Error("framework.yaml is invalid");
    };
    const { page, press } = await mount(false);
    server.read = async () => view;
    await press(page.getByRole("button", { name: "Retry" }));
    expect(document.activeElement).toBe(page.getByRole("textbox", { name: /^Filter/ }));
  });

  test("leaving with an unsaved draft asks first, and stays when declined", async () => {
    const { cell, press, app } = await mount();
    await press(cell("analyst/acme-db"));
    const asked: string[] = [];
    window.confirm = (message?: string) => {
      asked.push(String(message));
      return false;
    };
    // A blocked navigation never settles, so it is not awaited.
    await act(async () => {
      void app.navigate({ to: "/skills" });
    });
    await settle();
    expect(asked).toEqual(["Discard unsaved changes?"]);
    expect(app.state.location.pathname).toBe("/mcp");
  });

  test("an audience cell cycles inherit, enable, disable; a base cell toggles", async () => {
    const { cell, press } = await mount();
    const states: (string | undefined)[] = [];
    for (let click = 0; click < 3; click += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one click after another
      await press(cell("analyst/acme-db"));
      states.push(cell("analyst/acme-db").dataset.state);
    }
    expect(states).toEqual(["enable", "disable", "inherit"]);
    expect(cell("base/acme-db").dataset.state).toBe("enabled");
    await press(cell("base/acme-db"));
    expect(cell("base/acme-db").dataset.state).toBe("off");
  });

  test("the server form shows core's refusal and adds nothing until core accepts", async () => {
    const reason = "mcpManager.servers.acme-new: env entry 1 is not a variable name";
    server.preview = () => ({ ok: false, reason });
    const { page, press } = await mount();
    await press(page.getByRole("button", { name: "Add server" }));
    const form = within(screen.getByRole("dialog"));
    fireEvent.change(form.getByLabelText(/^Name/), { target: { value: "acme-new" } });
    fireEvent.change(form.getByLabelText("Command"), { target: { value: "acme-new-mcp" } });
    fireEvent.change(form.getByLabelText(/^Environment variable names/), {
      target: { value: "acme token" },
    });
    await press(form.getByRole("button", { name: "Add server" }));
    expect(form.getByRole("alert").textContent).toBe(reason);
    expect(page.container.querySelector('[data-mcp-server="acme-new"]')).toBeNull();

    server.preview = () => accepted;
    await press(form.getByRole("button", { name: "Add server" }));
    expect(page.container.querySelector('[data-mcp-server="acme-new"]')?.textContent).toContain(
      "acme-new-mcp",
    );
  });

  test("a save sends the whole draft with the read's token and says when it applies", async () => {
    const { page, cell, press } = await mount();
    await press(cell("analyst/acme-db"));
    await press(cell("analyst/acme-db"));
    await press(page.getByRole("button", { name: "Save" }));
    expect(server.saves).toHaveLength(1);
    expect(server.saves[0]!.token).toBe(view.token);
    expect(server.saves[0]!.next.audiences.analyst?.disable?.servers).toEqual(["acme-db"]);
    expect(page.getByRole("status").textContent).toContain("next sync or launch");
  });

  test("a conflict shows the file's current data and keeps the edits", async () => {
    const current: McpManagerView = {
      ...view,
      catalog: { servers: { "acme-next": { command: "acme-next-mcp" } } },
      token: "b".repeat(64),
    };
    server.save = () => ({ kind: "conflict", current });
    const { page, cell, press } = await mount();
    await press(cell("analyst/acme-db"));
    await press(page.getByRole("button", { name: "Save" }));
    const conflict = page.container.querySelector<HTMLElement>("[data-mcp-conflict]")!;
    expect(conflict.textContent).toContain("acme-next");
    expect(cell("analyst/acme-db").dataset.state).toBe("enable");

    await press(within(conflict).getByRole("button", { name: /Overwrite/ }));
    expect(server.saves.map((save) => save.token)).toEqual([view.token, current.token]);
  });

  test("a read-only Studio shows the data with every edit control disabled", async () => {
    const { page } = await mount(false);
    expect(page.container.querySelector("[data-mcp-read-only]")?.textContent).toContain(
      "--writable",
    );
    const buttons = [...page.container.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.filter((button) => !button.disabled)).toEqual([]);
    expect(page.container.querySelector('[data-mcp-server="acme-docs"]')?.textContent).toContain(
      "missing",
    );
  });
});
