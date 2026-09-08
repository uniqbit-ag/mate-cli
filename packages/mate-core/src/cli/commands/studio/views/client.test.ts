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

  it("reaches no host and holds no connection", () => {
    for (const source of Object.values(scripts)) {
      expect(source).not.toMatch(/https?:\/\//);
      expect(source).not.toMatch(/\bfetch\b|EventSource|WebSocket|setInterval/);
    }
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

  it("switches the visible workflow branch without rebuilding the page", () => {
    expect(STUDIO_CLIENT_SCRIPT).toContain('querySelectorAll("[data-workflow-switch]")');
    expect(STUDIO_CLIENT_SCRIPT).toContain('querySelectorAll("[data-workflow-profile]")');
    expect(STUDIO_CLIENT_SCRIPT).toContain('getAttribute("data-workflow-branch")');
    expect(STUDIO_CLIENT_SCRIPT).toContain('"data-active"');
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

  it("renders nothing and assembles no markup", () => {
    expect(STUDIO_CLIENT_SCRIPT).not.toMatch(/innerHTML|outerHTML|createElement/);
  });
});
