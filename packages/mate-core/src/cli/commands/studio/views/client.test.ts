import { afterEach, describe, expect, it } from "bun:test";

import {
  COMPANION_STORAGE_KEY,
  STUDIO_PREPAINT_SCRIPT,
  THEME_STORAGE_KEY,
  VAULT_TREE_STORAGE_KEY,
} from "./client";
import { STUDIO_CLIENT_BUNDLE } from "./studio-client.generated";
import { startStudioClient } from "./studio-client";

const realSetTimeout = globalThis.setTimeout;
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 0));

const restorers: (() => void)[] = [];

/** Installs browser globals for one run of the client; `afterEach` puts the real ones back. */
function stubBrowser(stubs: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(stubs)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    restorers.push(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete (globalThis as Record<string, unknown>)[name];
    });
  }
}

afterEach(() => {
  while (restorers.length > 0) restorers.pop()!();
});

/** Runs the prepaint script against a stubbed browser and reports where it navigated. */
function runPrepaint(search: string, stored: Record<string, string> = {}): string[] {
  const replaced: string[] = [];
  const location = { search, pathname: "/", replace: (url: string) => replaced.push(url) };
  const store = { getItem: (key: string) => stored[key] ?? null };
  const documentStub = { documentElement: { setAttribute: () => {} } };
  new Function("localStorage", "location", "document", STUDIO_PREPAINT_SCRIPT)(
    store,
    location,
    documentStub,
  );
  return replaced;
}

const acmeDigest = "4cb87fd83f";

/** Just enough of an element for the vault browser code: attributes, children, and simple selectors. */
class FakeElement {
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  listeners: Record<string, (event?: unknown) => void> = {};
  hidden = false;
  open = false;
  value = "";
  textContent = "";

  constructor(attributes: Record<string, string> = {}, children: FakeElement[] = []) {
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
    for (const child of children) this.append(child);
    this.hidden = this.attributes.has("hidden");
    this.open = this.attributes.has("open");
  }

  append(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  addEventListener(event: string, handler: (event?: unknown) => void): void {
    this.listeners[event] = handler;
  }

  replaceWith(node: FakeElement): void {
    const siblings = this.parent!.children;
    siblings[siblings.indexOf(this)] = node;
    node.parent = this.parent;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children = [];
    for (const node of nodes) this.append(node);
  }

  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parent) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  get body(): { childNodes: FakeElement[] } {
    return { childNodes: this.children };
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  matches(selector: string): boolean {
    const excluded = [...selector.matchAll(/:not\(\[([\w-]+)\]\)/g)].map(([, name]) => name!);
    const plain = selector.replace(/:not\(\[[\w-]+\]\)/g, "");
    const tag = /^[a-z]+/.exec(plain)?.[0];
    if (tag && this.getAttribute("tag") !== tag) return false;
    for (const name of excluded) {
      if (name === "hidden" ? this.hidden : this.hasAttribute(name)) return false;
    }
    return [...plain.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) =>
      value === undefined ? this.hasAttribute(name!) : this.getAttribute(name!) === value,
    );
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((node) => node.matches(selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

interface Store {
  values: Record<string, string>;
  /** When set, every read and write throws, as a blocked web store does. */
  blocked?: boolean;
}

function storage(store: Store) {
  return {
    getItem: (key: string) => {
      if (store.blocked) throw new Error("blocked");
      return store.values[key] ?? null;
    },
    setItem: (key: string, value: string) => {
      if (store.blocked) throw new Error("blocked");
      store.values[key] = value;
    },
  };
}

/** A page of `FakeElement`s: lookups by id, selector and attribute work as the client expects. */
function page(elements: FakeElement[], root = new FakeElement()) {
  const body = new FakeElement({}, elements);
  const documentStub = {
    documentElement: root,
    getElementById: (id: string) => body.querySelector(`[id="${id}"]`),
    querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    importNode: (node: FakeElement) => node,
  };
  return { body, root, documentStub };
}

function runClient(options: {
  clipboard: unknown;
  elements?: FakeElement[];
  store?: Store;
  extra?: Record<string, unknown>;
}) {
  const toast = new FakeElement({ id: "studio-toast" });
  const theme = new FakeElement({ id: "studio-theme" });
  const { body, root, documentStub } = page([toast, theme, ...(options.elements ?? [])]);
  const store = options.store ?? { values: {} };
  stubBrowser({
    document: documentStub,
    localStorage: storage(store),
    navigator: options.clipboard === null ? {} : { clipboard: options.clipboard },
    setTimeout: () => 0,
    clearTimeout: () => {},
    ...options.extra,
  });
  startStudioClient();
  return { body, root, toast, theme, store };
}

function runVaultBrowser(options: {
  layout: Record<string, string>;
  tree: FakeElement;
  listing?: FakeElement;
  /** Served for every parse; `answers` are served first, in order. */
  answer?: FakeElement;
  answers?: FakeElement[];
  fails?: boolean | ((url: string) => boolean);
  stored?: string | null;
  editor?: FakeElement;
}) {
  const filter = new FakeElement({ id: "vault-filter", hidden: "" });
  const results = new FakeElement({ id: "vault-filter-results", hidden: "" });
  const stale = new FakeElement({ id: "vault-stale", hidden: "" });
  const status = new FakeElement({ id: "vault-refresh-status", hidden: "" });
  const refresh = new FakeElement({ tag: "form", "data-vault-refresh": "" });
  const toggle = new FakeElement({ id: "vault-tree-toggle", hidden: "" });
  const panel = new FakeElement({ id: "vault-tree-panel" }, [
    refresh,
    stale,
    status,
    filter,
    results,
    options.tree,
  ]);
  const layout = new FakeElement({ "data-vault-layout": "", ...options.layout }, [
    panel,
    toggle,
    ...(options.listing ? [options.listing] : []),
    ...(options.editor ? [options.editor] : []),
  ]);
  const root = new FakeElement();
  if (options.stored === "hidden") root.setAttribute("data-vault-tree", "hidden");
  const { body, documentStub } = page([layout], root);
  const stored: Record<string, string> = {};
  const fetched: string[] = [];
  const streamed: string[] = [];
  const navigated: string[] = [];
  const timers: (() => void)[] = [];
  const sources: EventSourceStub[] = [];
  const answers = [...(options.answers ?? [])];
  class EventSourceStub {
    onmessage: ((message: { data: string }) => void) | null = null;
    constructor(url: string) {
      streamed.push(url);
      sources.push(this);
    }
  }
  class Parser {
    parseFromString() {
      return answers.shift() ?? options.answer;
    }
  }
  const fetchStub = (url: string) => {
    fetched.push(url);
    const failing = typeof options.fails === "function" ? options.fails(url) : options.fails;
    return failing
      ? Promise.reject(new Error("offline"))
      : Promise.resolve({ ok: true, text: () => Promise.resolve("answer") });
  };
  stubBrowser({
    document: documentStub,
    localStorage: {
      getItem: () => null,
      setItem: (key: string, value: string) => (stored[key] = value),
    },
    navigator: {},
    setTimeout: (callback: () => void) => timers.push(callback),
    clearTimeout: () => {},
    fetch: fetchStub,
    DOMParser: Parser,
    EventSource: EventSourceStub,
    location: { href: "http://localhost/", assign: (url: string) => navigated.push(url) },
  });
  startStudioClient();
  return {
    body,
    root,
    filter,
    results,
    stale,
    status,
    refresh,
    panel,
    toggle,
    stored,
    fetched,
    streamed,
    navigated,
    sources,
    /** Runs the debounced filter the last input scheduled. */
    flushFilter: () => timers.at(-1)?.(),
  };
}

function sampleTree(): FakeElement {
  return new FakeElement({ "data-vault-slot": "tree" }, [
    new FakeElement(
      { "data-vault-dir": "docs", tag: "details", "data-vault-children-url": "/dir?d=docs" },
      [new FakeElement({ class: "vault-children" })],
    ),
    new FakeElement(
      { "data-vault-dir": "other", tag: "details", open: "", "data-vault-expanded": "" },
      [new FakeElement({ "data-vault-entry": "other/gamma.md", tag: "a" })],
    ),
  ]);
}

describe("studio browser code", () => {
  it("ships as valid JavaScript that cannot terminate a script element", () => {
    for (const source of [STUDIO_PREPAINT_SCRIPT, STUDIO_CLIENT_BUNDLE]) {
      expect(() => new Function(source)).not.toThrow();
      expect(source.toLowerCase()).not.toContain("</script");
    }
  });

  it("reaches no external host and builds no markup", () => {
    for (const source of [STUDIO_PREPAINT_SCRIPT, STUDIO_CLIENT_BUNDLE]) {
      expect(source).not.toMatch(/https?:\/\//);
    }
    expect(STUDIO_CLIENT_BUNDLE).not.toMatch(/innerHTML|outerHTML|createElement/);
  });

  it("opens the vault events address the page rendered, building none", () => {
    const address = "/api/vault/events?companion=4cb87fd83f&view=vault&path=docs%2Fa+b.md";
    const editor = new FakeElement({ "data-vault-root": "" }, [
      new FakeElement({
        id: "vault-editor",
        "data-vault-path": "docs/a b.md",
        "data-vault-events": address,
      }),
    ]);
    const run = runVaultBrowser({ layout: {}, tree: sampleTree(), editor });
    expect(run.streamed).toEqual([address]);
    expect(STUDIO_CLIENT_BUNDLE).not.toContain("/api/vault/events");
  });

  it("applies a remembered appearance before the page paints", () => {
    expect(STUDIO_PREPAINT_SCRIPT).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
    expect(STUDIO_PREPAINT_SCRIPT).toContain('setAttribute("data-theme", chosen)');
    expect(STUDIO_PREPAINT_SCRIPT).toContain("try");
  });

  it("cycles the appearance through system, dark, and light and remembers each", () => {
    const run = runClient({ clipboard: null });
    expect(run.theme.textContent).toBe("Theme: system");
    expect(run.root.hasAttribute("data-theme")).toBe(false);
    const click = () => run.theme.listeners.click!();
    click();
    expect(run.root.getAttribute("data-theme")).toBe("dark");
    expect(run.theme.textContent).toBe("Theme: dark");
    expect(run.store.values[THEME_STORAGE_KEY]).toBe("dark");
    click();
    expect(run.root.getAttribute("data-theme")).toBe("light");
    expect(run.store.values[THEME_STORAGE_KEY]).toBe("light");
    click();
    expect(run.root.hasAttribute("data-theme")).toBe(false);
    expect(run.theme.getAttribute("data-theme-state")).toBe("system");
    expect(run.store.values[THEME_STORAGE_KEY]).toBe("system");
  });

  it("starts from the remembered appearance and falls back to system for anything else", () => {
    const light = runClient({
      clipboard: null,
      store: { values: { [THEME_STORAGE_KEY]: "light" } },
    });
    expect(light.root.getAttribute("data-theme")).toBe("light");
    const odd = runClient({ clipboard: null, store: { values: { [THEME_STORAGE_KEY]: "neon" } } });
    expect(odd.theme.textContent).toBe("Theme: system");
  });

  it("costs only the preference, never the page, when the web store is blocked", () => {
    const company = new FakeElement({ "data-companion": acmeDigest });
    const run = runClient({
      clipboard: null,
      elements: [company],
      store: { values: {}, blocked: true },
    });
    expect(() => run.theme.listeners.click!()).not.toThrow();
    expect(run.root.getAttribute("data-theme")).toBe("dark");
    expect(run.store.values).toEqual({});
  });

  it("remembers the companion the served page resolved", () => {
    const run = runClient({
      clipboard: null,
      elements: [new FakeElement({ "data-companion": acmeDigest })],
    });
    expect(run.store.values[COMPANION_STORAGE_KEY]).toBe(acmeDigest);
    const none = runClient({ clipboard: null });
    expect(none.store.values[COMPANION_STORAGE_KEY]).toBeUndefined();
  });

  it("switches workflow schema tabs in memory without leaving the page", () => {
    const tab = (profile: string, selected: boolean) =>
      new FakeElement({
        "data-workflow-schema-profile": profile,
        "aria-selected": selected ? "true" : "false",
      });
    const panel = (profile: string) => new FakeElement({ "data-workflow-schema-panel": profile });
    const [claude, opencode] = [tab("claude", true), tab("opencode", false)];
    const [claudePanel, opencodePanel] = [panel("claude"), panel("opencode")];
    runClient({
      clipboard: null,
      elements: [
        new FakeElement({ "data-workflow-schema-root": "" }, [
          claude,
          opencode,
          claudePanel,
          opencodePanel,
        ]),
      ],
    });
    expect(claudePanel.getAttribute("data-active")).toBe("true");
    expect(opencodePanel.getAttribute("data-active")).toBe("false");
    opencode.listeners.click!();
    expect(claude.getAttribute("aria-selected")).toBe("false");
    expect(opencode.getAttribute("aria-selected")).toBe("true");
    expect(claudePanel.getAttribute("data-active")).toBe("false");
    expect(opencodePanel.getAttribute("data-active")).toBe("true");
    expect(opencodePanel.hasAttribute("aria-hidden")).toBe(false);
  });

  it("switches Skills tabs in memory and hides the inactive panel from assistive technology", () => {
    const tab = (profile: string, selected: boolean) =>
      new FakeElement({
        "data-skill-profile": profile,
        "aria-selected": selected ? "true" : "false",
      });
    const panel = (profile: string) => new FakeElement({ "data-skill-panel": profile });
    const [claude, opencode] = [tab("claude", true), tab("opencode", false)];
    const [claudePanel, opencodePanel] = [panel("claude"), panel("opencode")];
    runClient({
      clipboard: null,
      elements: [
        new FakeElement({ "data-skills-root": "" }, [claude, opencode, claudePanel, opencodePanel]),
      ],
    });
    expect(opencodePanel.getAttribute("aria-hidden")).toBe("true");
    opencode.listeners.click!();
    expect(claudePanel.getAttribute("aria-hidden")).toBe("true");
    expect(opencodePanel.getAttribute("aria-hidden")).toBe("false");
    expect(opencodePanel.getAttribute("data-active")).toBe("true");
  });

  it("copies whatever a control carries and confirms it in the page", async () => {
    const copied: string[] = [];
    const control = new FakeElement({
      "data-copy": "the prompt",
      "data-copy-label": "the prompt text",
    });
    const run = runClient({
      clipboard: { writeText: async (text: string) => void copied.push(text) },
      elements: [control],
    });
    control.listeners.click!();
    await settle();
    expect(copied).toEqual(["the prompt"]);
    expect(run.toast.textContent).toBe("copied the prompt text");
    expect(run.toast.getAttribute("data-shown")).toBe("true");
  });

  it("handles an absent or rejected clipboard without breaking other controls", async () => {
    const control = () => new FakeElement({ "data-copy": "prompt" });
    const absentControl = control();
    const unavailable = runClient({ clipboard: null, elements: [absentControl] });
    expect(() => absentControl.listeners.click!()).not.toThrow();
    expect(unavailable.toast.textContent).toBe("copying is blocked in this browser");
    expect(() => unavailable.theme.listeners.click!()).not.toThrow();

    const rejectedControl = control();
    const rejected = runClient({
      clipboard: { writeText: async () => Promise.reject(new Error("blocked")) },
      elements: [rejectedControl],
    });
    expect(() => rejectedControl.listeners.click!()).not.toThrow();
    await settle();
    expect(rejected.toast.textContent).toBe("copying is blocked in this browser");
  });

  it("swaps a deferred tree and listing for the server's answer and wires their forms", async () => {
    const answeredTree = sampleTree();
    const answeredListing = new FakeElement({ "data-vault-slot": "listing" }, [
      new FakeElement({ tag: "form", method: "get" }),
    ]);
    const run = runVaultBrowser({
      layout: { "data-vault-view": "/api/vault/view?companion=abc" },
      tree: new FakeElement({ "data-vault-slot": "tree", "aria-busy": "true" }),
      listing: new FakeElement({ "data-vault-slot": "listing", "aria-busy": "true" }),
      answer: new FakeElement({}, [answeredTree, answeredListing]),
    });
    await settle();
    await settle();
    expect(run.fetched).toEqual(["/api/vault/view?companion=abc"]);
    expect(run.body.querySelector('[data-vault-slot="tree"]')).toBe(answeredTree);
    expect(run.body.querySelector('[data-vault-slot="listing"]')).toBe(answeredListing);
    expect(answeredListing.children[0]!.listeners.submit).toBeDefined();
    expect(answeredTree.querySelector("[data-vault-entry]")!.listeners.click).toBeUndefined();
  });

  it("states a failed deferred listing in place of the placeholders", async () => {
    const tree = new FakeElement({ "data-vault-slot": "tree", "aria-busy": "true" });
    runVaultBrowser({ layout: { "data-vault-view": "/api/vault/view" }, tree, fails: true });
    await settle();
    await settle();
    expect(tree.textContent).toBe("The files could not be listed: offline");
    expect(tree.hasAttribute("aria-busy")).toBe(false);
  });

  it("fetches nothing when the tree came with the page", () => {
    const run = runVaultBrowser({ layout: {}, tree: sampleTree() });
    expect(run.fetched).toEqual([]);
  });

  it("filters over the listed tree on the server, debounced and bounded to the typed text", async () => {
    const tree = sampleTree();
    const run = runVaultBrowser({
      layout: { "data-vault-filter-url": "/api/vault/filter?companion=abc" },
      tree,
      answer: new FakeElement({}, [
        new FakeElement({ "data-vault-entry": "docs/beta.md", tag: "a" }),
      ]),
    });
    expect(run.filter.hidden).toBe(false);
    run.filter.value = "BE";
    run.filter.listeners.input!();
    run.filter.value = "BETA";
    run.filter.listeners.input!();
    expect(run.fetched).toEqual([]);
    run.flushFilter();
    await settle();
    await settle();
    expect(run.fetched).toEqual(["http://localhost/api/vault/filter?companion=abc&q=BETA"]);
    expect(run.results.hidden).toBe(false);
    expect(run.results.children).toHaveLength(1);
    expect(run.panel.hasAttribute("data-vault-filtering")).toBe(true);
    run.filter.value = "";
    run.filter.listeners.input!();
    run.flushFilter();
    expect(run.results.hidden).toBe(true);
    expect(run.panel.hasAttribute("data-vault-filtering")).toBe(false);
    expect(run.fetched).toHaveLength(1);
  });

  it("attaches one delegated click handler for tree entries and leaves modified clicks alone", () => {
    const run = runVaultBrowser({ layout: {}, tree: sampleTree() });
    const link = run.body.querySelector("[data-vault-entry]")!;
    link.setAttribute("href", "/?path=other%2Fgamma.md");
    Object.assign(link, { href: "http://localhost/?path=other%2Fgamma.md" });
    expect(link.listeners.click).toBeUndefined();
    let prevented = false;
    const click = (extra: Record<string, unknown> = {}) =>
      run.panel.listeners.click!({
        button: 0,
        target: link,
        preventDefault: () => (prevented = true),
        ...extra,
      });
    click({ ctrlKey: true });
    expect(prevented).toBe(false);
    click({ button: 1 });
    expect(prevented).toBe(false);
    click();
    expect(prevented).toBe(true);
  });

  it("fetches a collapsed folder's entries when first opened and retries after a failure", async () => {
    const tree = sampleTree();
    const run = runVaultBrowser({
      layout: {},
      tree,
      fails: (url) => url === "/dir?d=docs" && run.fetched.length === 1,
      answer: new FakeElement({}, [
        new FakeElement({ "data-vault-entry": "docs/alpha.md", tag: "a" }),
      ]),
    });
    const docs = tree.children[0]!;
    docs.open = true;
    run.panel.listeners.toggle!({ target: docs });
    await settle();
    await settle();
    expect(run.fetched).toEqual(["/dir?d=docs"]);
    expect(docs.children[0]!.textContent).toBe("This folder could not be loaded: offline");
    expect(docs.hasAttribute("data-vault-loaded")).toBe(false);
    run.panel.listeners.toggle!({ target: docs });
    await settle();
    await settle();
    expect(run.fetched).toEqual(["/dir?d=docs", "/dir?d=docs"]);
    expect(docs.children[0]!.children).toHaveLength(1);
    expect(docs.hasAttribute("data-vault-loaded")).toBe(true);
    run.panel.listeners.toggle!({ target: docs });
    expect(run.fetched).toHaveLength(2);
  });

  it("marks the displayed tree stale on a newer generation and clears it only on a current refresh", async () => {
    const shown = new FakeElement({ "data-vault-slot": "tree", "data-vault-generation": "2" });
    const run = runVaultBrowser({
      layout: {
        "data-vault-changes-url": "/api/vault/changes?companion=abc",
        "data-vault-refresh-url": "/api/vault/view?companion=abc&refresh=1",
      },
      tree: shown,
      answers: [
        new FakeElement({}, [
          new FakeElement({ "data-vault-slot": "tree", "data-vault-generation": "3" }),
        ]),
        new FakeElement({}, [
          new FakeElement({ "data-vault-slot": "tree", "data-vault-generation": "4" }),
        ]),
      ],
    });
    expect(run.streamed).toEqual(["/api/vault/changes?companion=abc"]);
    const send = (generation: number) =>
      run.sources[0]!.onmessage!({
        data: JSON.stringify({ type: "vault-tree-changed", generation }),
      });
    send(2);
    expect(run.stale.hidden).toBe(true);
    send(4);
    expect(run.stale.hidden).toBe(false);
    const submit = () => run.refresh.listeners.submit!({ preventDefault: () => {} });
    submit();
    await settle();
    await settle();
    expect(run.fetched).toEqual(["/api/vault/view?companion=abc&refresh=1"]);
    expect(run.stale.hidden).toBe(false);
    submit();
    await settle();
    await settle();
    expect(run.stale.hidden).toBe(true);
  });

  it("keeps the indicator and offers a retry when a refresh fails", async () => {
    const run = runVaultBrowser({
      layout: {
        "data-vault-changes-url": "/changes",
        "data-vault-refresh-url": "/refresh-view",
      },
      tree: new FakeElement({ "data-vault-slot": "tree", "data-vault-generation": "1" }),
      fails: true,
    });
    run.sources[0]!.onmessage!({
      data: JSON.stringify({ type: "vault-tree-changed", generation: 2 }),
    });
    run.refresh.listeners.submit!({ preventDefault: () => {} });
    await settle();
    await settle();
    expect(run.stale.hidden).toBe(false);
    expect(run.status.hidden).toBe(false);
    expect(run.status.textContent).toContain("could not be refreshed: offline");
    expect(run.status.textContent).toContain("Refresh tree to retry");
  });

  it("applies a change that arrives before the deferred tree to the tree once it lands", async () => {
    const run = runVaultBrowser({
      layout: { "data-vault-view": "/api/vault/view", "data-vault-changes-url": "/changes" },
      tree: new FakeElement({ "data-vault-slot": "tree", "aria-busy": "true" }),
      answer: new FakeElement({}, [
        new FakeElement({ "data-vault-slot": "tree", "data-vault-generation": "1" }),
      ]),
    });
    run.sources[0]!.onmessage!({
      data: JSON.stringify({ type: "vault-tree-changed", generation: 2 }),
    });
    expect(run.stale.hidden).toBe(true);
    await settle();
    await settle();
    expect(run.stale.hidden).toBe(false);
  });

  it("hides and shows the tree and remembers the choice in the browser", () => {
    const run = runVaultBrowser({ layout: {}, tree: sampleTree() });
    expect(run.toggle.hidden).toBe(false);
    run.toggle.listeners.click!();
    expect(run.root.getAttribute("data-vault-tree")).toBe("hidden");
    expect(run.toggle.textContent).toBe("Show files");
    expect(run.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(run.stored[VAULT_TREE_STORAGE_KEY]).toBe("hidden");
    run.toggle.listeners.click!();
    expect(run.root.hasAttribute("data-vault-tree")).toBe(false);
    expect(run.stored[VAULT_TREE_STORAGE_KEY]).toBe("shown");
  });

  it("restores a hidden tree before the page paints", () => {
    expect(STUDIO_PREPAINT_SCRIPT).toContain(`localStorage.getItem("${VAULT_TREE_STORAGE_KEY}")`);
    const run = runVaultBrowser({ layout: {}, tree: sampleTree(), stored: "hidden" });
    expect(run.toggle.textContent).toBe("Show files");
  });

  it("restores the remembered companion into the URL before the page paints", () => {
    expect(runPrepaint("", { [COMPANION_STORAGE_KEY]: acmeDigest })).toEqual([
      `/?companion=${acmeDigest}`,
    ]);
  });

  it("keeps the rest of the URL while restoring", () => {
    expect(runPrepaint("?view=workflow", { [COMPANION_STORAGE_KEY]: acmeDigest })).toEqual([
      `/?view=workflow&companion=${acmeDigest}`,
    ]);
  });

  it("leaves a URL that already names a companion alone", () => {
    expect(runPrepaint("?companion=aaaaaaaaaa", { [COMPANION_STORAGE_KEY]: acmeDigest })).toEqual(
      [],
    );
  });

  it("treats an empty companion parameter as a deliberate none, so the restore cannot loop", () => {
    expect(runPrepaint("?companion=", { [COMPANION_STORAGE_KEY]: acmeDigest })).toEqual([]);
  });

  it("restores nothing from a store holding no digest of ours", () => {
    expect(runPrepaint("", {})).toEqual([]);
    expect(runPrepaint("", { [COMPANION_STORAGE_KEY]: "../../etc/passwd" })).toEqual([]);
    expect(runPrepaint("", { [COMPANION_STORAGE_KEY]: "ABCDEF0123" })).toEqual([]);
  });
});

describe("the vault editor in the page client", () => {
  function editorPage(options: {
    value?: string;
    fetchResult?: () => Promise<unknown>;
    stream?: boolean;
  }) {
    const editor = new FakeElement({
      id: "vault-editor",
      "data-vault-path": "docs/a.md",
      "data-vault-token": "t1",
      ...(options.stream ? { "data-vault-events": "/events" } : {}),
    });
    editor.value = options.value ?? "hello";
    const part = (id: string, attributes: Record<string, string> = {}) =>
      new FakeElement({ id, hidden: "", ...attributes });
    const save = part("vault-save");
    const recover = part("vault-recover");
    const incoming = part("vault-incoming");
    const incomingContent = part("vault-incoming-content");
    const status = part("vault-status");
    const company = new FakeElement({ "data-companion": acmeDigest });
    const root = new FakeElement({ "data-vault-root": "" }, [
      editor,
      save,
      recover,
      incoming,
      incomingContent,
      status,
    ]);
    const { documentStub } = page([company, root]);
    const posted: { url: string; body: Record<string, unknown> }[] = [];
    const sources: { onmessage: ((message: { data: string }) => void) | null }[] = [];
    const handlers: Record<string, (event: unknown) => void> = {};
    class EventSourceStub {
      onmessage: ((message: { data: string }) => void) | null = null;
      constructor() {
        sources.push(this);
      }
    }
    stubBrowser({
      document: documentStub,
      localStorage: { getItem: () => null, setItem: () => {} },
      navigator: {},
      setTimeout: () => 0,
      clearTimeout: () => {},
      EventSource: EventSourceStub,
      window: {
        addEventListener: (name: string, handler: (event: unknown) => void) =>
          (handlers[name] = handler),
      },
      fetch: (url: string, init: { body: string }) => {
        posted.push({ url, body: JSON.parse(init.body) });
        return options.fetchResult
          ? options.fetchResult()
          : Promise.resolve({ ok: true, status: 200, json: async () => ({ token: "t2" }) });
      },
    });
    startStudioClient();
    return { editor, save, recover, incoming, incomingContent, status, posted, sources, handlers };
  }

  it("saves the editor text with the companion, path and token, then adopts the new token", async () => {
    const run = editorPage({});
    run.editor.value = "edited";
    run.save.listeners.click!();
    await settle();
    expect(run.posted).toEqual([
      {
        url: "/api/vault/save",
        body: { companion: acmeDigest, path: "docs/a.md", content: "edited", token: "t1" },
      },
    ]);
    expect(run.status.textContent).toBe("saved");
    expect(run.editor.getAttribute("data-vault-token")).toBe("t2");
    expect(run.editor.getAttribute("data-vault-original")).toBe("edited");
  });

  it("refuses a second save while one is in flight", async () => {
    const run = editorPage({});
    run.save.listeners.click!();
    run.save.listeners.click!();
    await settle();
    expect(run.posted).toHaveLength(1);
  });

  it("offers the incoming version after a conflict and loads it on recover", async () => {
    const run = editorPage({
      fetchResult: () =>
        Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ reason: "changed on disk", content: "theirs", token: "t9" }),
        }),
    });
    run.editor.value = "mine";
    run.save.listeners.click!();
    await settle();
    expect(run.status.textContent).toBe("changed on disk");
    expect(run.incoming.hidden).toBe(false);
    expect(run.incomingContent.textContent).toBe("theirs");
    run.recover.listeners.click!();
    expect(run.editor.value).toBe("theirs");
    expect(run.editor.getAttribute("data-vault-token")).toBe("t9");
    expect(run.incoming.hidden).toBe(true);
    expect(run.status.textContent).toBe("incoming version loaded into the editor");
  });

  it("states a failed save", async () => {
    const run = editorPage({ fetchResult: () => Promise.reject(new Error("offline")) });
    run.save.listeners.click!();
    await settle();
    expect(run.status.textContent).toBe("save failed");
  });

  it("follows the file on disk, keeping unsaved text and offering the new version instead", () => {
    const run = editorPage({ stream: true });
    const send = (event: unknown) => run.sources[0]!.onmessage!({ data: JSON.stringify(event) });
    send({ kind: "changed", content: "from disk", token: "t3" });
    expect(run.editor.value).toBe("from disk");
    expect(run.status.textContent).toBe("updated from disk");
    run.editor.value = "typing";
    send({ kind: "changed", content: "newer", token: "t4" });
    expect(run.editor.value).toBe("typing");
    expect(run.incomingContent.textContent).toBe("newer");
    expect(run.status.textContent).toContain("unsaved content is still in the editor");
    send({ kind: "removed" });
    expect(run.status.textContent).toBe("this file no longer exists on disk");
    send({ kind: "overwritten", content: "old" });
    expect(run.incomingContent.textContent).toBe("old");
    run.sources[0]!.onmessage!({ data: "not json" });
  });

  it("asks the browser to confirm leaving only while the editor is dirty", () => {
    const run = editorPage({});
    let prevented = false;
    const event = { preventDefault: () => (prevented = true), returnValue: "unset" as unknown };
    run.handlers.beforeunload!(event);
    expect(prevented).toBe(false);
    run.editor.value = "changed";
    run.handlers.beforeunload!(event);
    expect(prevented).toBe(true);
    expect(event.returnValue).toBe("");
  });
});

describe("spec skill actions in the page client", () => {
  function run(viewed: string | null) {
    let click: ((event: unknown) => void) | undefined;
    const dispatched: { type: string; detail: unknown }[] = [];
    const copied: string[] = [];
    const documentStub = {
      documentElement: {
        setAttribute: () => {},
        removeAttribute: () => {},
        getAttribute: (name: string) => (name === "data-agent-viewed" ? viewed : null),
      },
      getElementById: () => ({
        textContent: "",
        setAttribute: () => {},
        removeAttribute: () => {},
        addEventListener: () => {},
      }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (event: string, handler: (event: unknown) => void) => {
        if (event === "click") click = handler;
      },
      dispatchEvent: (event: { type: string; detail: unknown }) => void dispatched.push(event),
    };
    class FakeEvent {
      constructor(
        public type: string,
        init: { detail: unknown },
      ) {
        this.detail = init.detail;
      }
      detail: unknown;
    }
    stubBrowser({
      document: documentStub,
      localStorage: { getItem: () => null, setItem: () => {} },
      navigator: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
      setTimeout: () => 0,
      clearTimeout: () => {},
      CustomEvent: FakeEvent,
    });
    startStudioClient();
    const node = (selector: string, attributes: Record<string, string>) => ({
      closest: (query: string) =>
        query === selector ? { getAttribute: (n: string) => attributes[n] ?? null } : null,
    });
    return {
      dispatched,
      copied,
      clickRun: () =>
        click?.({
          target: node("[data-studio-action]", {
            "data-studio-action": "show-me",
            "data-studio-subject": "acme-login",
            "data-studio-agents": "claude opencode",
          }),
        }),
      clickCopy: () =>
        click?.({
          target: node("[data-studio-copy-prompt]", {
            "data-prompt-claude": "/mate-show-me acme-login",
            "data-prompt-opencode": "Use the mate-show-me skill on spec acme-login.",
          }),
        }),
    };
  }

  it("dispatches studio:terminal-action only on a run click", () => {
    const page = run(null);
    page.clickRun();
    expect(page.dispatched).toHaveLength(1);
    expect(page.dispatched[0]).toMatchObject({
      type: "studio:terminal-action",
      detail: { action: "show-me", subject: "acme-login", agents: ["claude", "opencode"] },
    });
    page.clickCopy();
    expect(page.dispatched).toHaveLength(1);
  });

  it("copies the viewed agent's prompt, else Claude's", async () => {
    const opencode = run("opencode");
    opencode.clickCopy();
    await settle();
    expect(opencode.copied).toEqual(["Use the mate-show-me skill on spec acme-login."]);
    const claude = run(null);
    claude.clickCopy();
    await settle();
    expect(claude.copied).toEqual(["/mate-show-me acme-login"]);
  });
});
