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
});
