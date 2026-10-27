import { describe, expect, it } from "bun:test";

import { STUDIO_STYLES } from "./styles";

describe("studio styles", () => {
  it("defines the light palette on bare :root and both explicit theme overrides", () => {
    expect(STUDIO_STYLES).toContain(":root {");
    expect(STUDIO_STYLES).toContain("@media (prefers-color-scheme: light)");
    expect(STUDIO_STYLES).toContain("@media (prefers-color-scheme: dark)");
    expect(STUDIO_STYLES).toContain(':root[data-theme="light"]');
    expect(STUDIO_STYLES).toContain(':root[data-theme="dark"]');
  });

  it("guards each media query so an explicit choice wins", () => {
    expect(STUDIO_STYLES).toContain(':root:not([data-theme="dark"])');
    expect(STUDIO_STYLES).toContain(':root:not([data-theme="light"])');
  });

  it("paints the page rather than inheriting the host colors", () => {
    expect(STUDIO_STYLES).toContain("background: var(--bg)");
    expect(STUDIO_STYLES).toContain("color: var(--text)");
  });

  it("uses one wider content cap for every page", () => {
    expect(STUDIO_STYLES).toContain(".main > * { width: min(100%, 1180px);");
    expect(STUDIO_STYLES).not.toContain(".workflow-view { width:");
  });

  it("keeps secondary header context unboxed and aligned to the header row", () => {
    expect(STUDIO_STYLES).toContain(".page-header { display: flex; align-items: stretch;");
    expect(STUDIO_STYLES).toContain(
      ".page-context { display: grid; align-content: start; gap: 6px;",
    );
    expect(STUDIO_STYLES).toContain(
      "padding: 0; border: 0; border-radius: 0; background: transparent;",
    );
  });

  it("carries the token palette every view reads", () => {
    for (const token of [
      "--bg",
      "--panel",
      "--border",
      "--text",
      "--muted",
      "--accent",
      "--done",
      "--warn",
      "--bad",
      "--what",
      "--why",
      "--prompt-bg",
      "--mono",
    ]) {
      expect(STUDIO_STYLES).toContain(`${token}:`);
    }
  });

  it("loads no external resource", () => {
    expect(STUDIO_STYLES).not.toMatch(/@import|url\(/);
  });

  it("keeps pre-explore skill choices free of the accent border", () => {
    expect(STUDIO_STYLES).toContain(
      ".workflow-option { display: grid; gap: 1px; padding-left: 8px; }",
    );
    expect(STUDIO_STYLES).not.toContain(
      ".workflow-option { display: grid; gap: 1px; padding-left: 8px; border-left:",
    );
  });

  it("scopes the terminal grid to a shell that carries the terminal", () => {
    expect(STUDIO_STYLES).toContain(
      ".shell[data-terminal] { grid-template-columns: 224px minmax(0, 1fr) clamp(360px, var(--terminal-width, min(560px, 40vw)), 70vw); }",
    );
    expect(STUDIO_STYLES).toContain(
      ":root[data-terminal-collapsed] .shell[data-terminal] { grid-template-columns: 224px minmax(0, 1fr) var(--terminal-strip, 44px); }",
    );
    for (const line of STUDIO_STYLES.split("\n")) {
      if (line.includes("grid-template-columns") && line.includes("--terminal")) {
        expect(line).toContain(".shell[data-terminal]");
      }
    }
  });

  it("keeps the terminal sidebar docked at full height", () => {
    expect(STUDIO_STYLES).toMatch(
      /\.terminal-sidebar \{[^}]*position: sticky;[^}]*top: 0;[^}]*height: 100vh;/,
    );
    expect(STUDIO_STYLES).toContain(".terminal-view { flex: 1;");
    expect(STUDIO_STYLES).toMatch(/\.terminal-sessions-footer \{[^}]*overflow-y: auto;/);
  });

  it("collapses only side by side and becomes a drawer below 1200px", () => {
    const wide = STUDIO_STYLES.slice(STUDIO_STYLES.indexOf("@media (min-width: 1201px)"));
    expect(wide.slice(0, wide.indexOf("\n}\n"))).toContain("data-terminal-collapsed");
    const narrow = STUDIO_STYLES.slice(STUDIO_STYLES.indexOf("@media (max-width: 1200px)"));
    const drawer = narrow.slice(0, narrow.indexOf("\n}\n"));
    expect(drawer).toContain(".shell[data-terminal] .terminal-sidebar {");
    expect(drawer).toContain("position: fixed;");
    expect(drawer).toContain("transform: translateX(100%);");
    expect(drawer).toContain(".terminal-sidebar[data-drawer-open] { transform: none;");
    expect(drawer).toContain(".terminal-drawer-open { display: block;");
    expect(drawer).not.toContain("grid-template-columns");
  });

  /** Splits a selector list on its top-level commas, leaving `:is(a, b)` whole. */
  const selectorList = (selectors: string): string[] => {
    const parts = [""];
    let depth = 0;
    for (const char of selectors) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) parts.push("");
      else parts[parts.length - 1] += char;
    }
    return parts.map((part) => part.trim());
  };

  /** The declarations of every rule whose selector list contains `selector`. */
  const ruleFor = (selector: string): string => {
    const bodies = STUDIO_STYLES.split("}").flatMap((rule) => {
      const open = rule.indexOf("{");
      const selectors = rule.slice(0, open).split("\n").at(-1) ?? "";
      return selectorList(selectors).includes(selector) ? [rule.slice(open + 1)] : [];
    });
    if (bodies.length === 0) throw new Error(`no rule for ${selector}`);
    return bodies.join("\n");
  };

  it("frames cards and panes flat: surface, rule border, 8px corners, no shadow", () => {
    for (const card of [".panel", ".specs-area-card", ".workflow-console"]) {
      const rule = ruleFor(card);
      expect(rule).toContain("background: var(--panel)");
      expect(rule).toContain("border: 1px solid var(--border)");
      expect(rule).toContain("border-radius: 8px");
    }
    // Only the off-canvas terminal drawer and its opener float over the page.
    const shadows = STUDIO_STYLES.split("\n").filter((line) => line.includes("box-shadow"));
    expect(shadows).toHaveLength(2);
    for (const line of shadows) expect(line).toContain("box-shadow: var(--drawer-shadow)");
  });

  it("gives every status a marker shaped like the report's tone markers", () => {
    expect(ruleFor('.status-chip[data-status="complete"]::before')).toContain("border-radius: 50%");
    expect(ruleFor(".chip-done::before")).toContain("border-radius: 50%");
    expect(ruleFor(".spec-status::before")).toContain("border-radius: 50%");
    expect(
      ruleFor('.status-chip:is([data-status="active"], [data-status="in-progress"])::before'),
    ).toContain("transform: rotate(45deg)");
    expect(ruleFor(".chip-invalid::before")).toContain("border-radius: 0");
    expect(ruleFor(".spec-status-invalid::before")).toContain("border-radius: 0");
    expect(ruleFor('.picker-card[data-unready="true"] .picker-card-name::before')).toContain(
      "clip-path: polygon(50% 0, 100% 100%, 0 100%)",
    );
  });

  it("colours complete and active statuses differently", () => {
    expect(ruleFor('.status-chip[data-status="complete"]')).toContain("color: var(--done)");
    expect(
      ruleFor('.status-chip:is([data-status="active"], [data-status="in-progress"])'),
    ).toContain("color: var(--info)");
    expect(ruleFor(".chip-done")).toContain("color: var(--done)");
    expect(ruleFor(".chip-invalid")).toContain("color: var(--bad)");
  });

  it("keeps a visible border and focus outline on buttons and selects", () => {
    expect(ruleFor("button")).toContain("border: 1px solid var(--border)");
    expect(ruleFor("button:focus-visible")).toContain("outline: 2px solid var(--accent)");
    expect(ruleFor("select:focus-visible")).toContain("outline: 2px solid var(--accent)");
  });

  it("sets headings and tiles in the report's type scale", () => {
    expect(ruleFor("h1")).toContain("font-size: 1.6rem; font-weight: 650");
    const label = ruleFor(".section-header h3");
    expect(label).toContain("color: var(--muted)");
    expect(label).toContain("text-transform: uppercase");
    expect(ruleFor(".page-eyebrow")).not.toContain("var(--accent)");
    for (const tile of [".sidebar-metric", ".specs-summary-item"]) {
      expect(ruleFor(tile)).toContain("border-top: 1px solid var(--border)");
      expect(ruleFor(`${tile} strong`)).toContain("font-variant-numeric: tabular-nums");
    }
  });

  it("keeps the rail compact with the stats stacked as one column", () => {
    expect(ruleFor(".shell")).toContain("grid-template-columns: 224px minmax(0, 1fr)");
    expect(ruleFor(".sidebar-metrics")).not.toContain("repeat(3");
    const metric = ruleFor(".sidebar-metric");
    expect(metric).toContain("display: flex");
    expect(metric).toContain("justify-content: space-between");
  });
});
