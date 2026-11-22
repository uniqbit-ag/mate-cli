import { afterEach, describe, expect, it } from "bun:test";

await import("../../test/dom");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { mountPluginView, PluginView } = await import("./plugin-view");

const CONTEXT = { companion: "abcdef0123", apiBase: "/api/plugins/acme", writable: true };

/** A view module that writes its context into the element and records its unmount. */
function acmeModule(log: string[]) {
  return async (url: string) => {
    log.push(`load ${url}`);
    return {
      mount: (element: HTMLElement, context: typeof CONTEXT) => {
        element.textContent = `acme board for ${context.companion} at ${context.apiBase}`;
        return () => void log.push("unmount");
      },
    };
  };
}

/** Renders into a detached element, so the shared document stays as other tests left it. */
async function render(ui: React.ReactNode) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(ui));
  return { container, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = undefined;
});

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe("mounting a plugin view", () => {
  it("loads the module and hands mount the element and the context", async () => {
    const log: string[] = [];
    const element = document.createElement("div");
    const unmount = await mountPluginView(
      element,
      "/studio/plugins/acme/board/view.js",
      CONTEXT,
      acmeModule(log),
    );
    expect(element.textContent).toBe("acme board for abcdef0123 at /api/plugins/acme");
    unmount();
    expect(log).toEqual(["load /studio/plugins/acme/board/view.js", "unmount"]);
  });

  it("refuses a module without a mount export", async () => {
    await expect(
      mountPluginView(document.createElement("div"), "/x.js", CONTEXT, async () => ({})),
    ).rejects.toThrow("no mount export");
  });

  it("mounts in the browser and unmounts when the view leaves", async () => {
    const log: string[] = [];
    const load = acmeModule(log);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const view = await render(
      <PluginView moduleUrl="/studio/plugins/acme/board/view.js" context={CONTEXT} load={load} />,
    );
    await settle();
    expect(view.container.textContent).toContain("acme board for abcdef0123");
    await view.unmount();
    expect(log).toEqual(["load /studio/plugins/acme/board/view.js", "unmount"]);
  });

  it("says why a view could not load", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const view = await render(
      <PluginView
        moduleUrl="/studio/plugins/acme/board/view.js"
        context={CONTEXT}
        load={async () => {
          throw new Error("offline");
        }}
      />,
    );
    await settle();
    expect(view.container.textContent).toContain("The view could not load: offline");
    await view.unmount();
  });
});
