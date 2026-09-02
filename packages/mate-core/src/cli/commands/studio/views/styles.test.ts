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
