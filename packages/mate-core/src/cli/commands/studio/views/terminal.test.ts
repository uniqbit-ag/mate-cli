import { describe, expect, it } from "bun:test";

import {
  STUDIO_TERMINAL_PREPAINT_SCRIPT,
  STUDIO_TERMINAL_SCRIPT,
  STUDIO_TERMINAL_SIDEBAR_SCRIPT,
  TERMINAL_COLLAPSED_KEY,
  TERMINAL_WIDTH_KEY,
} from "./terminal";

type Handler = (event?: unknown) => void;

/** Minimal element: attributes, listeners, inline custom properties. */
function element() {
  const attributes = new Map<string, string>();
  const listeners = new Map<string, Handler>();
  const properties = new Map<string, string>();
  return {
    attributes,
    properties,
    listeners,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
    hasAttribute: (name: string) => attributes.has(name),
    getAttribute: (name: string) => attributes.get(name) ?? null,
    addEventListener: (event: string, handler: Handler) => void listeners.set(event, handler),
    fire: (event: string, payload?: unknown) => listeners.get(event)?.(payload),
    focus: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => true,
    style: {
      setProperty: (name: string, value: string) => void properties.set(name, value),
    },
  };
}

function storage(stored: Record<string, string>, blocked = false) {
  const fail = () => {
    throw new Error("blocked");
  };
  return {
    stored,
    getItem: blocked ? fail : (key: string) => stored[key] ?? null,
    setItem: blocked
      ? fail
      : (key: string, value: string) => {
          stored[key] = value;
        },
  };
}

function runPrepaint(stored: Record<string, string>, innerWidth = 1600, blocked = false) {
  const root = element();
  new Function("localStorage", "document", "window", STUDIO_TERMINAL_PREPAINT_SCRIPT)(
    storage(stored, blocked),
    { documentElement: root },
    { innerWidth },
  );
  return root;
}

function runSidebar(options: { blocked?: boolean; collapsed?: boolean } = {}) {
  const root = element();
  if (options.collapsed) root.setAttribute("data-terminal-collapsed", "");
  const nodes: Record<string, ReturnType<typeof element>> = {};
  for (const id of [
    "studio-terminal-panel",
    "terminal-collapse",
    "terminal-expand",
    "terminal-resize",
    "terminal-drawer-open",
    "terminal-drawer-close",
  ]) {
    nodes[id] = element();
  }
  const documentListeners = new Map<string, Handler>();
  const store = storage({}, options.blocked);
  new Function("localStorage", "document", "window", STUDIO_TERMINAL_SIDEBAR_SCRIPT)(
    store,
    {
      documentElement: root,
      getElementById: (id: string) => nodes[id] ?? null,
      addEventListener: (event: string, handler: Handler) => documentListeners.set(event, handler),
    },
    { innerWidth: 1600 },
  );
  return { root, nodes, store, key: (key: string) => documentListeners.get("keydown")?.({ key }) };
}

describe("terminal prepaint", () => {
  it("applies the remembered width and collapsed state", () => {
    const root = runPrepaint({ [TERMINAL_WIDTH_KEY]: "640", [TERMINAL_COLLAPSED_KEY]: "true" });
    expect(root.properties.get("--terminal-width")).toBe("640px");
    expect(root.hasAttribute("data-terminal-collapsed")).toBe(true);
  });

  it("clamps a remembered width to its bounds", () => {
    expect(runPrepaint({ [TERMINAL_WIDTH_KEY]: "100" }).properties.get("--terminal-width")).toBe(
      "360px",
    );
    expect(runPrepaint({ [TERMINAL_WIDTH_KEY]: "9999" }).properties.get("--terminal-width")).toBe(
      "1120px",
    );
  });

  it("leaves the defaults for nothing stored, junk, or a blocked store", () => {
    for (const root of [
      runPrepaint({}),
      runPrepaint({ [TERMINAL_WIDTH_KEY]: "wide", [TERMINAL_COLLAPSED_KEY]: "yes" }),
      runPrepaint({ [TERMINAL_WIDTH_KEY]: "640" }, 1600, true),
    ]) {
      expect(root.properties.size).toBe(0);
      expect(root.hasAttribute("data-terminal-collapsed")).toBe(false);
    }
  });

  it("uses Studio-prefixed keys", () => {
    expect(TERMINAL_WIDTH_KEY.startsWith("mate-studio-")).toBe(true);
    expect(TERMINAL_COLLAPSED_KEY.startsWith("mate-studio-")).toBe(true);
  });
});

describe("terminal sidebar script", () => {
  it("collapses and expands, remembering the state", () => {
    const { root, nodes, store } = runSidebar();
    nodes["terminal-collapse"]!.fire("click");
    expect(root.hasAttribute("data-terminal-collapsed")).toBe(true);
    expect(nodes["terminal-expand"]!.getAttribute("aria-expanded")).toBe("false");
    expect(store.stored[TERMINAL_COLLAPSED_KEY]).toBe("true");
    nodes["terminal-expand"]!.fire("click");
    expect(root.hasAttribute("data-terminal-collapsed")).toBe(false);
    expect(store.stored[TERMINAL_COLLAPSED_KEY]).toBe("false");
  });

  it("reflects a prepainted collapse in the controls", () => {
    const { nodes } = runSidebar({ collapsed: true });
    expect(nodes["terminal-collapse"]!.getAttribute("aria-expanded")).toBe("false");
  });

  it("drags the width within bounds and stores it on release", () => {
    const { root, nodes, store } = runSidebar();
    const handle = nodes["terminal-resize"]!;
    handle.fire("pointerdown", { pointerId: 1, preventDefault: () => {} });
    handle.fire("pointermove", { clientX: 1000 });
    expect(root.properties.get("--terminal-width")).toBe("600px");
    handle.fire("pointermove", { clientX: 1500 });
    expect(root.properties.get("--terminal-width")).toBe("360px");
    handle.fire("pointermove", { clientX: 0 });
    expect(root.properties.get("--terminal-width")).toBe("1120px");
    handle.fire("pointerup", { pointerId: 1 });
    expect(store.stored[TERMINAL_WIDTH_KEY]).toBe("1120");
  });

  it("ignores pointer moves without a drag", () => {
    const { root, nodes } = runSidebar();
    nodes["terminal-resize"]!.fire("pointermove", { clientX: 1000 });
    expect(root.properties.size).toBe(0);
  });

  it("keeps working when the store is blocked", () => {
    const { root, nodes } = runSidebar({ blocked: true });
    expect(() => nodes["terminal-collapse"]!.fire("click")).not.toThrow();
    expect(root.hasAttribute("data-terminal-collapsed")).toBe(true);
    const handle = nodes["terminal-resize"]!;
    handle.fire("pointerdown", { pointerId: 1, preventDefault: () => {} });
    handle.fire("pointermove", { clientX: 1000 });
    expect(() => handle.fire("pointerup", { pointerId: 1 })).not.toThrow();
  });

  it("opens the drawer and dismisses it with the close control or Escape, remembering nothing", () => {
    const { nodes, store, key } = runSidebar();
    const panel = nodes["studio-terminal-panel"]!;
    nodes["terminal-drawer-open"]!.fire("click");
    expect(panel.hasAttribute("data-drawer-open")).toBe(true);
    key("Escape");
    expect(panel.hasAttribute("data-drawer-open")).toBe(false);
    nodes["terminal-drawer-open"]!.fire("click");
    nodes["terminal-drawer-close"]!.fire("click");
    expect(panel.hasAttribute("data-drawer-open")).toBe(false);
    expect(Object.keys(store.stored)).toEqual([]);
  });
});

/** Runs the terminal client against stubbed xterm.js, observer, and socket. */
function runTerminal() {
  const nodes: Record<string, ReturnType<typeof element>> = {
    "studio-terminal-panel": element(),
  };
  const mount = { ...element(), clientWidth: 0, clientHeight: 0 };
  const calls = { open: 0, fit: 0 };
  const sent: unknown[] = [];
  let observed: unknown;
  let observerCallback: (() => void) | undefined;
  let resizeHandler: ((size: { cols: number; rows: number }) => void) | undefined;
  const frames: (() => void)[] = [];
  class Terminal {
    cols = 80;
    rows = 24;
    unicode = { activeVersion: "" };
    loadAddon() {}
    open() {
      calls.open += 1;
    }
    onData() {}
    onResize(handler: typeof resizeHandler) {
      resizeHandler = handler;
    }
  }
  class ResizeObserver {
    constructor(callback: () => void) {
      observerCallback = callback;
    }
    observe(target: unknown) {
      observed = target;
    }
  }
  class WebSocket {
    readyState = 1;
    send(message: string) {
      sent.push(JSON.parse(message));
    }
  }
  const addon = (name: string) => ({
    [name]: class {
      fit() {
        calls.fit += 1;
      }
    },
  });
  const noop = () => {};
  new Function(
    "document",
    "Terminal",
    "FitAddon",
    "Unicode11Addon",
    "WebLinksAddon",
    "ClipboardAddon",
    "ResizeObserver",
    "requestAnimationFrame",
    "WebSocket",
    "sessionStorage",
    "fetch",
    "setInterval",
    "getComputedStyle",
    "location",
    "window",
    STUDIO_TERMINAL_SCRIPT,
  )(
    {
      documentElement: {},
      getElementById: (id: string) => (id === "studio-terminal" ? mount : (nodes[id] ?? null)),
      querySelectorAll: () => [],
    },
    Terminal,
    addon("FitAddon"),
    addon("Unicode11Addon"),
    addon("WebLinksAddon"),
    addon("ClipboardAddon"),
    ResizeObserver,
    (callback: () => void) => frames.push(callback),
    WebSocket,
    storage({}),
    () => new Promise(noop),
    noop,
    () => ({ getPropertyValue: () => "" }),
    { protocol: "http:", host: "localhost" },
    {},
  );
  return {
    mount,
    calls,
    sent,
    observed: () => observed,
    observe: () => observerCallback?.(),
    frames,
    resize: (cols: number, rows: number) => resizeHandler?.({ cols, rows }),
  };
}

describe("terminal fitting", () => {
  it("fits from an observer on the terminal area, not the window", () => {
    const run = runTerminal();
    expect(run.observed()).toBe(run.mount);
    expect(STUDIO_TERMINAL_SCRIPT).not.toContain('window.addEventListener("resize"');
  });

  it("skips a zero size and opens xterm.js only once visible", () => {
    const run = runTerminal();
    expect(run.calls).toEqual({ open: 0, fit: 0 });
    run.observe();
    run.frames.shift()!();
    expect(run.calls).toEqual({ open: 0, fit: 0 });
    run.mount.clientWidth = 400;
    run.mount.clientHeight = 300;
    run.observe();
    run.frames.shift()!();
    expect(run.calls).toEqual({ open: 1, fit: 1 });
    run.observe();
    run.frames.shift()!();
    expect(run.calls).toEqual({ open: 1, fit: 2 });
  });

  it("coalesces observer bursts to one fit per frame", () => {
    const run = runTerminal();
    run.observe();
    run.observe();
    run.observe();
    expect(run.frames).toHaveLength(1);
  });

  it("sends resize only when the cell size changes", () => {
    const run = runTerminal();
    run.resize(80, 24);
    run.resize(100, 30);
    run.resize(100, 30);
    expect(run.sent.filter((message) => (message as { type: string }).type === "resize")).toEqual([
      { type: "resize", cols: 100, rows: 30 },
    ]);
  });
});
