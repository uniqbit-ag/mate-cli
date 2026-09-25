import { describe, expect, it } from "bun:test";

import {
  COMPANION_STORAGE_KEY,
  STUDIO_CLIENT_SCRIPT,
  STUDIO_PREPAINT_SCRIPT,
  THEME_STORAGE_KEY,
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
    expect(STUDIO_CLIENT_SCRIPT).toContain('new EventSource("/api/vault/events?');
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

  it("stores the chosen appearance in the browser only", () => {
    expect(STUDIO_CLIENT_SCRIPT).toContain("localStorage.setItem(THEME_KEY, theme)");
    expect(STUDIO_CLIENT_SCRIPT.match(/localStorage/g)).toHaveLength(3);
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
