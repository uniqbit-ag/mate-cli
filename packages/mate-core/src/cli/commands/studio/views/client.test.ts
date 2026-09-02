import { describe, expect, it } from "bun:test";

import { STUDIO_CLIENT_SCRIPT, STUDIO_PREPAINT_SCRIPT, THEME_STORAGE_KEY } from "./client";

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
    expect(STUDIO_CLIENT_SCRIPT.match(/localStorage/g)).toHaveLength(2);
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
