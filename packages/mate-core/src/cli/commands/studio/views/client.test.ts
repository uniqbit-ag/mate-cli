import { describe, expect, it } from "bun:test";

import {
  COMPANION_STORAGE_KEY,
  STUDIO_CLIENT_SCRIPT,
  STUDIO_PREPAINT_SCRIPT,
  THEME_STORAGE_KEY,
  VAULT_TREE_STORAGE_KEY,
} from "./client";

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

const scripts = { prepaint: STUDIO_PREPAINT_SCRIPT, client: STUDIO_CLIENT_SCRIPT };

function runClient(clipboard: unknown): {
  copy: () => void;
  theme: () => void;
  toast: () => string;
} {
  let copyHandler: (() => void) | undefined;
  let themeHandler: (() => void) | undefined;
  const toast = { textContent: "", setAttribute: () => {} };
  const theme = {
    textContent: "",
    setAttribute: () => {},
    removeAttribute: () => {},
    addEventListener: (_event: string, handler: () => void) => {
      themeHandler = handler;
    },
  };
  const copy = {
    getAttribute: (name: string) => (name === "data-copy" ? "prompt" : "copy"),
    addEventListener: (_event: string, handler: () => void) => {
      copyHandler = handler;
    },
  };
  const documentStub = {
    documentElement: { setAttribute: () => {}, removeAttribute: () => {} },
    getElementById: (id: string) =>
      id === "studio-theme" ? theme : id === "studio-toast" ? toast : null,
    querySelector: () => null,
    querySelectorAll: (selector: string) => (selector === "[data-copy]" ? [copy] : []),
  };
  const store = { getItem: () => null, setItem: () => {} };
  new Function(
    "document",
    "localStorage",
    "navigator",
    "setTimeout",
    "clearTimeout",
    STUDIO_CLIENT_SCRIPT,
  )(
    documentStub,
    store,
    clipboard === null ? {} : { clipboard },
    () => 0,
    () => {},
  );
  return {
    copy: () => copyHandler?.(),
    theme: () => themeHandler?.(),
    toast: () => toast.textContent,
  };
}

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

  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  matches(selector: string): boolean {
    const notHidden = selector.endsWith(":not([hidden])");
    const plain = notHidden ? selector.slice(0, -":not([hidden])".length) : selector;
    const tag = /^[a-z]+/.exec(plain)?.[0];
    if (tag && this.getAttribute("tag") !== tag) return false;
    if (notHidden && this.hidden) return false;
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

function runVaultBrowser(options: {
  layout: Record<string, string>;
  tree: FakeElement;
  listing?: FakeElement;
  answer?: FakeElement;
  fails?: boolean;
  stored?: string | null;
  editor?: FakeElement;
}) {
  const filter = new FakeElement({ id: "vault-filter", hidden: "" });
  const toggle = new FakeElement({ id: "vault-tree-toggle", hidden: "" });
  const layout = new FakeElement({ "data-vault-layout": "", ...options.layout }, [
    filter,
    options.tree,
    toggle,
    ...(options.listing ? [options.listing] : []),
    ...(options.editor ? [options.editor] : []),
  ]);
  const body = new FakeElement({}, [layout]);
  const root = new FakeElement();
  if (options.stored === "hidden") root.setAttribute("data-vault-tree", "hidden");
  const stored: Record<string, string> = {};
  const fetched: string[] = [];
  const streamed: string[] = [];
  class EventSourceStub {
    onmessage: unknown = null;
    constructor(url: string) {
      streamed.push(url);
    }
  }
  const documentStub = {
    documentElement: root,
    getElementById: (id: string) => body.querySelector(`[id="${id}"]`),
    querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    importNode: (node: FakeElement) => node,
  };
  class Parser {
    parseFromString() {
      return options.answer;
    }
  }
  const fetchStub = (url: string) => {
    fetched.push(url);
    return options.fails
      ? Promise.reject(new Error("offline"))
      : Promise.resolve({ ok: true, text: () => Promise.resolve("answer") });
  };
  new Function(
    "document",
    "localStorage",
    "navigator",
    "setTimeout",
    "clearTimeout",
    "fetch",
    "DOMParser",
    "EventSource",
    STUDIO_CLIENT_SCRIPT,
  )(
    documentStub,
    { getItem: () => null, setItem: (key: string, value: string) => (stored[key] = value) },
    {},
    () => 0,
    () => {},
    fetchStub,
    Parser,
    EventSourceStub,
  );
  return { body, root, filter, toggle, stored, fetched, streamed };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function sampleTree(): FakeElement {
  return new FakeElement({ "data-vault-slot": "tree" }, [
    new FakeElement({ "data-vault-dir": "docs" }, [
      new FakeElement({ "data-vault-entry": "docs/alpha.md", tag: "form", method: "get" }),
      new FakeElement({ "data-vault-entry": "docs/beta.md", tag: "form", method: "get" }),
    ]),
    new FakeElement({ "data-vault-dir": "other", open: "", "data-vault-expanded": "" }, [
      new FakeElement({ "data-vault-entry": "other/gamma.md", tag: "form", method: "get" }),
    ]),
  ]);
}

describe("studio browser code", () => {
  it("is valid JavaScript", () => {
    for (const source of Object.values(scripts)) {
      expect(() => new Function(source)).not.toThrow();
    }
  });

  it("cannot terminate the element that carries it", () => {
    for (const source of Object.values(scripts)) {
      expect(source.toLowerCase()).not.toContain("</script");
    }
  });

  it("reaches no external host while allowing the vault event stream", () => {
    for (const source of Object.values(scripts)) {
      expect(source).not.toMatch(/https?:\/\//);
    }
    expect(STUDIO_CLIENT_SCRIPT).toContain('fetch("/api/vault/save"');
    expect(STUDIO_CLIENT_SCRIPT).toContain('getAttribute("data-vault-events")');
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
    expect(STUDIO_CLIENT_SCRIPT).not.toContain("/api/vault/events?");
    expect(STUDIO_CLIENT_SCRIPT).not.toContain("/api/vault/events");
  });

  it("applies a remembered appearance before the page paints", () => {
    expect(STUDIO_PREPAINT_SCRIPT).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
    expect(STUDIO_PREPAINT_SCRIPT).toContain('setAttribute("data-theme", chosen)');
    expect(STUDIO_PREPAINT_SCRIPT).toContain("try");
  });

  it("cycles the appearance through system, dark, and light", () => {
    expect(STUDIO_CLIENT_SCRIPT).toContain('["system", "dark", "light"]');
    expect(STUDIO_CLIENT_SCRIPT).toContain('removeAttribute("data-theme")');
    expect(STUDIO_CLIENT_SCRIPT).toContain('setAttribute("data-theme", next)');
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
    expect(answeredTree.querySelector("[data-vault-entry]")!.listeners.submit).toBeDefined();
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

  it("filters the tree by path and restores the served folders when cleared", () => {
    const tree = sampleTree();
    const run = runVaultBrowser({ layout: {}, tree });
    expect(run.filter.hidden).toBe(false);
    const [docs, other] = tree.children as [FakeElement, FakeElement];
    run.filter.value = "BETA";
    run.filter.listeners.input!();
    expect(docs.children.map((entry) => entry.hidden)).toEqual([true, false]);
    expect(docs.open).toBe(true);
    expect(other.hidden).toBe(true);
    run.filter.value = "";
    run.filter.listeners.input!();
    expect(docs.children.every((entry) => !entry.hidden)).toBe(true);
    expect(docs.open).toBe(false);
    expect(other.open).toBe(true);
    expect(other.hidden).toBe(false);
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

  it("stores the chosen appearance in the browser only", () => {
    expect(STUDIO_CLIENT_SCRIPT).toContain("localStorage.setItem(THEME_KEY, theme)");
    expect(STUDIO_CLIENT_SCRIPT.match(/localStorage/g)).toHaveLength(4);
  });

  it("remembers the companion the served page resolved", () => {
    expect(STUDIO_CLIENT_SCRIPT).toContain('querySelector("[data-companion]")');
    expect(STUDIO_CLIENT_SCRIPT).toContain("localStorage.setItem(COMPANION_KEY, current)");
    expect(STUDIO_CLIENT_SCRIPT).toContain(`"${COMPANION_STORAGE_KEY}"`);
  });

  it("switches workflow schema tabs in memory without changing the URL", () => {
    expect(STUDIO_CLIENT_SCRIPT).toContain('querySelectorAll("[data-workflow-schema-root]")');
    expect(STUDIO_CLIENT_SCRIPT).toContain('querySelectorAll("[data-workflow-schema-profile]")');
    expect(STUDIO_CLIENT_SCRIPT).toContain('querySelectorAll("[data-workflow-schema-panel]")');
    expect(STUDIO_CLIENT_SCRIPT).toContain('"aria-selected"');
    expect(STUDIO_CLIENT_SCRIPT).not.toContain("location.search = params.toString()");
  });

  it("switches Skills tabs in memory without changing the URL", () => {
    expect(STUDIO_CLIENT_SCRIPT).toContain('querySelectorAll("[data-skills-root]")');
    expect(STUDIO_CLIENT_SCRIPT).toContain('querySelectorAll("[data-skill-profile]")');
    expect(STUDIO_CLIENT_SCRIPT).toContain('querySelectorAll("[data-skill-panel]")');
    expect(STUDIO_CLIENT_SCRIPT).toContain('getAttribute("data-skill-profile")');
    expect(STUDIO_CLIENT_SCRIPT).toContain('getAttribute("data-skill-panel")');
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

  it("copies whatever a control carries and confirms it in the page", () => {
    expect(STUDIO_CLIENT_SCRIPT).toContain('querySelectorAll("[data-copy]")');
    expect(STUDIO_CLIENT_SCRIPT).toContain("navigator.clipboard.writeText(text)");
    expect(STUDIO_CLIENT_SCRIPT).toContain('announce("copied " + label)');
    expect(STUDIO_CLIENT_SCRIPT).toContain('getElementById("studio-toast")');
  });

  it("survives a blocked clipboard without costing the page", () => {
    expect(STUDIO_CLIENT_SCRIPT).toContain("copying is blocked in this browser");
  });

  it("handles an absent or rejected clipboard without breaking other controls", async () => {
    const unavailable = runClient(null);
    expect(() => unavailable.copy()).not.toThrow();
    expect(unavailable.toast()).toBe("copying is blocked in this browser");
    expect(() => unavailable.theme()).not.toThrow();

    const rejected = runClient({ writeText: async () => Promise.reject(new Error("blocked")) });
    expect(() => rejected.copy()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejected.toast()).toBe("copying is blocked in this browser");
  });

  it("renders nothing and assembles no markup", () => {
    expect(STUDIO_CLIENT_SCRIPT).not.toMatch(/innerHTML|outerHTML|createElement/);
  });
});
