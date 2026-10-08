import { describe, expect, it } from "bun:test";

import { STUDIO_CLIENT_SCRIPT } from "./client";

const ACME = "4cb87fd83f";
const BETA = "0123456789";
const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

class El {
  attrs = new Map<string, string>();
  hidden = false;
  textContent = "";
  href = "";
  src = "";
  children: El[] = [];
  listeners: Record<string, () => void> = {};
  parts: Record<string, El> = {};
  constructor(attrs: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value);
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  addEventListener(event: string, handler: () => void) {
    this.listeners[event] = handler;
  }
  replaceChildren() {
    this.children = [];
  }
  append(child: El) {
    this.children.push(child);
  }
  querySelectorAll(selector: string) {
    return selector === "button[data-report-id]" ? this.children.map((c) => c.parts.button!) : [];
  }
  querySelector(selector: string) {
    return this.parts[selector] ?? null;
  }
}

/** One `<li>` the template clones: its button, title and time. */
function item(): El {
  const li = new El();
  li.parts = {
    button: new El(),
    "button ": new El(),
    "[data-report-title]": new El(),
    "[data-report-time]": new El(),
  };
  li.parts.button = li.parts.button!;
  return li;
}

function run(options: { view: boolean; hash?: string; reports?: unknown[] }) {
  const shell = new El({
    "data-companion": ACME,
    "data-reports-url": `/api/reports?companion=${ACME}`,
    "data-reports-events-url": `/api/vault/changes?companion=${ACME}&scope=reports`,
    "data-reports-view-url": `/?companion=${ACME}&view=reports`,
  });
  const elements: Record<string, El> = {
    "reports-toast": new El(),
    "reports-toast-title": new El(),
    "reports-toast-open": new El(),
    "reports-badge": Object.assign(new El(), { hidden: true }),
  };
  if (options.view) {
    Object.assign(elements, {
      "reports-list": new El(),
      "reports-frame": Object.assign(new El(), { hidden: true }),
      "reports-open": Object.assign(new El(), { hidden: true }),
      "reports-empty": new El(),
      "reports-item-template": Object.assign(new El(), {
        content: { firstElementChild: { cloneNode: item } },
      }),
    });
  }
  const fetched: string[] = [];
  const sources: { url: string; onopen?: () => void; onmessage?: (m: { data: string }) => void }[] =
    [];
  class EventSourceStub {
    onopen?: () => void;
    onmessage?: (m: { data: string }) => void;
    constructor(url: string) {
      sources.push(Object.assign(this, { url }));
    }
  }
  const documentStub = {
    documentElement: new El(),
    getElementById: (id: string) => elements[id] ?? null,
    querySelector: (selector: string) => (selector === "[data-reports-events-url]" ? shell : null),
    querySelectorAll: () => [],
  };
  const timers: (() => void)[] = [];
  const replaced: string[] = [];
  new Function(
    "document",
    "localStorage",
    "setTimeout",
    "clearTimeout",
    "fetch",
    "EventSource",
    "location",
    "history",
    STUDIO_CLIENT_SCRIPT,
  )(
    documentStub,
    { getItem: () => null, setItem: () => {} },
    (callback: () => void) => timers.push(callback),
    () => {},
    (url: string) => {
      fetched.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ reports: options.reports ?? [] }),
      });
    },
    EventSourceStub,
    { href: "http://localhost/", hash: options.hash ?? "", search: "", pathname: "/" },
    { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
  );
  const send = (event: unknown) => sources[0]!.onmessage!({ data: JSON.stringify(event) });
  return { elements, fetched, sources, send, replaced };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const published = (companion: string, title = "Quarterly <b>report</b>") => ({
  type: "report-published",
  companion,
  id: ID_A,
  title,
  createdAt: 1,
});

describe("hosted reports in the page client", () => {
  it("opens the channel the page rendered, scoped to reports, building none", () => {
    const r = run({ view: false });
    expect(r.sources.map((s) => s.url)).toEqual([
      `/api/vault/changes?companion=${ACME}&scope=reports`,
    ]);
    expect(STUDIO_CLIENT_SCRIPT).not.toContain("/api/vault/changes");
  });

  it("does nothing without a rendered channel", () => {
    expect(() =>
      new Function("document", "EventSource", STUDIO_CLIENT_SCRIPT)(
        {
          documentElement: new El(),
          getElementById: () => null,
          querySelector: () => null,
          querySelectorAll: () => [],
        },
        class {},
      ),
    ).not.toThrow();
  });

  it("announces another view's new report with a toast and badge, as text, without navigating", () => {
    const r = run({ view: false });
    r.send(published(ACME));
    expect(r.elements["reports-badge"]!.hidden).toBe(false);
    expect(r.elements["reports-toast"]!.getAttribute("data-shown")).toBe("true");
    expect(r.elements["reports-toast-title"]!.textContent).toBe(
      "New report: Quarterly <b>report</b>",
    );
    expect(r.elements["reports-toast-open"]!.href).toBe(
      `/?companion=${ACME}&view=reports#report=${ID_A}`,
    );
    expect(r.replaced).toEqual([]);
  });

  it("ignores events for another companion and other event types", () => {
    const r = run({ view: false });
    r.send(published(BETA));
    r.send({ type: "vault-tree-changed", generation: 3 });
    r.sources[0]!.onmessage!({ data: "not json" });
    expect(r.elements["reports-badge"]!.hidden).toBe(true);
    expect(r.elements["reports-toast"]!.getAttribute("data-shown")).toBeNull();
  });

  it("loads the list on connect and reconnect, and again on a matching event", async () => {
    const r = run({ view: true, reports: [{ id: ID_B, title: "Old", createdAt: 1 }] });
    r.sources[0]!.onopen!();
    await settle();
    expect(r.fetched).toEqual([`/api/reports?companion=${ACME}`]);
    r.sources[0]!.onopen!();
    r.send(published(BETA));
    await settle();
    expect(r.fetched).toHaveLength(2);
    r.send(published(ACME));
    await settle();
    expect(r.fetched).toHaveLength(3);
    expect(r.elements["reports-badge"]!.hidden).toBe(true);
  });

  it("lists reports as text, opens the newest in the frame, and notes when there are none", async () => {
    const r = run({ view: true, reports: [{ id: ID_A, title: "<img src=x>", createdAt: 1 }] });
    r.sources[0]!.onopen!();
    await settle();
    const list = r.elements["reports-list"]!;
    expect(list.children).toHaveLength(1);
    expect(list.children[0]!.parts["[data-report-title]"]!.textContent).toBe("<img src=x>");
    expect(r.elements["reports-frame"]!.src).toBe(`/studio/reports/${ID_A}`);
    expect(r.elements["reports-frame"]!.hidden).toBe(false);
    expect(r.elements["reports-open"]!.href).toBe(`/studio/reports/${ID_A}`);
    expect(r.elements["reports-empty"]!.hidden).toBe(true);

    const none = run({ view: true, reports: [] });
    none.sources[0]!.onopen!();
    await settle();
    expect(none.elements["reports-empty"]!.hidden).toBe(false);
    expect(none.elements["reports-frame"]!.hidden).toBe(true);
  });

  it("opens the report the address names", async () => {
    const r = run({
      view: true,
      hash: `#report=${ID_B}`,
      reports: [
        { id: ID_A, title: "New", createdAt: 2 },
        { id: ID_B, title: "Old", createdAt: 1 },
      ],
    });
    r.sources[0]!.onopen!();
    await settle();
    expect(r.elements["reports-frame"]!.src).toBe(`/studio/reports/${ID_B}`);
  });
});
