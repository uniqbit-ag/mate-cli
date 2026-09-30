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
      ".shell[data-terminal] { grid-template-columns: 260px minmax(0, 1fr) clamp(360px, var(--terminal-width, min(560px, 40vw)), 70vw); }",
    );
    expect(STUDIO_STYLES).toContain(
      ":root[data-terminal-collapsed] .shell[data-terminal] { grid-template-columns: 260px minmax(0, 1fr) var(--terminal-strip, 44px); }",
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
});
