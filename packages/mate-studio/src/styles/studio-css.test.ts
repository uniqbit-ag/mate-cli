import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { studioPaletteCss } from "./palette";

const SOURCE = readFileSync(path.join(import.meta.dir, "app.css"), "utf8");
/** Whitespace collapsed, so checks read the rules whatever the file's formatting. */
const FLAT = SOURCE.replace(/\s+/g, " ");

const SRC = path.resolve(import.meta.dir, "..");
const ASSETS = path.resolve(import.meta.dir, "../../dist/client/assets");

/** Every TSX file under src, for the class names the views use. */
function views(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return views(full);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [full] : [];
  });
}

/** The declarations of the rule whose selector list starts with `selector`. */
function rule(selector: string): string {
  const start = FLAT.indexOf(`${selector} {`);
  if (start === -1) return "";
  return FLAT.slice(start, FLAT.indexOf("}", start));
}

describe("the stylesheet", () => {
  it("builds on Tailwind with its default colour and shadow scales removed", () => {
    expect(FLAT).toContain('@import "tailwindcss";');
    expect(FLAT).toContain("--color-*: initial;");
    expect(FLAT).toContain("--shadow-*: initial;");
  });

  it("binds every colour utility to a palette token", () => {
    const theme = /@theme inline \{([^}]*)\}/.exec(FLAT)?.[1] ?? "";
    const colours = [...theme.matchAll(/--color-([a-z-]+): ([^;]+);/g)];
    expect(colours.length).toBeGreaterThan(20);
    for (const [, name, value] of colours) {
      expect({ name, value }).toEqual({
        name,
        value: /^var\(--[a-z-]+\)$|^transparent$|^currentColor$/.test(value!) ? value! : "a token",
      });
    }
    for (const token of [
      "--bg",
      "--panel",
      "--border",
      "--text",
      "--muted",
      "--accent",
      "--warn",
      "--bad",
      "--why",
    ]) {
      expect(theme).toContain(`var(${token})`);
    }
  });

  it("offers one shadow, the floating one, from the palette", () => {
    expect(FLAT).toContain("--shadow-float: var(--drawer-shadow);");
    const shadows = [...FLAT.matchAll(/box-shadow: ([^;]+);/g)].map((match) => match[1]!);
    for (const value of shadows) {
      // Insets mark a current item and borders; only floating layers cast the palette shadow.
      expect(
        value === "var(--drawer-shadow)" || value === "none" || value.startsWith("inset"),
      ).toBe(true);
    }
  });

  it("declares no colour literal outside the terminal, which stays black in both appearances", () => {
    const own = FLAT.replace(rule(".terminal-view, .outcome-terminal"), "");
    expect(own).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(rule(".terminal-view, .outcome-terminal")).toContain("background: #000;");
  });

  it("loads no resource from another host", () => {
    expect(FLAT).not.toMatch(/url\(/);
    expect(FLAT.match(/@import/g)).toHaveLength(1);
  });

  it("styles browser surfaces from the tokens: selection, caret, scrollbars, focus and numerals", () => {
    expect(FLAT).toMatch(/::selection \{ background: color-mix\(in srgb, var\(--accent\)/);
    expect(FLAT).toContain("caret-color: var(--accent);");
    expect(FLAT).toContain("scrollbar-color: var(--border) transparent;");
    expect(rule(":focus-visible")).toContain("outline: 2px solid var(--accent);");
    expect(FLAT).toContain("font-variant-numeric: tabular-nums;");
    expect(FLAT).toContain("text-underline-offset: 3px;");
  });

  it("keeps the palette the single source of the colour values", () => {
    expect(studioPaletteCss()).toContain("--drawer-shadow:");
    expect(FLAT).not.toMatch(/--(bg|panel|text|accent):/);
  });
});

describe("the views' class names", () => {
  const sources = views().map(
    (file) => [path.relative(SRC, file), readFileSync(file, "utf8")] as const,
  );

  it("use no arbitrary colour literal", () => {
    for (const [file, text] of sources) {
      expect({ file, literal: /\[(#[0-9a-fA-F]{3,8}|rgba?\()/.exec(text)?.[0] ?? null }).toEqual({
        file,
        literal: null,
      });
    }
  });

  it("cast no shadow except the floating one", () => {
    for (const [file, text] of sources) {
      const shadows = [...text.matchAll(/(?<![\w-])shadow-([\w[\]_-]+)/g)].map(
        (match) => match[1]!,
      );
      for (const shadow of shadows) {
        expect({
          file,
          shadow,
          allowed: shadow === "float" || shadow.startsWith("[inset"),
        }).toEqual({
          file,
          shadow,
          allowed: true,
        });
      }
    }
  });
});

describe("the terminal frame", () => {
  it("adds its column only to a frame that carries the terminal", () => {
    expect(FLAT).toContain(
      ".studio-frame[data-terminal] { grid-template-columns: var(--rail-w) minmax(0, 1fr) clamp( 360px, var(--terminal-width, min(560px, 40vw)), 70vw );",
    );
    expect(FLAT).toContain(
      ":root[data-terminal-collapsed] .studio-frame[data-terminal] { grid-template-columns: var(--rail-w) minmax(0, 1fr) var(--terminal-strip, 44px);",
    );
  });

  it("collapses only side by side and floats as a drawer below 1200px", () => {
    const wide = FLAT.slice(FLAT.indexOf("@media (min-width: 1201px)"));
    expect(wide.slice(0, wide.indexOf("@media (max-width: 1200px)"))).toContain(
      "data-terminal-collapsed",
    );
    const narrow = FLAT.slice(FLAT.indexOf("@media (max-width: 1200px)"));
    const drawer = narrow.slice(0, narrow.indexOf("/* Navigation feedback"));
    expect(drawer).toContain("position: fixed;");
    expect(drawer).toContain("box-shadow: var(--drawer-shadow);");
    expect(drawer).toContain(".terminal-sidebar[data-drawer-open] { transform: none;");
    expect(drawer).not.toContain("grid-template-columns");
  });

  it("gives the terminal the navigation sidebar's tint", () => {
    expect(rule(".terminal-sidebar")).toContain("background: var(--bg-rail);");
  });
});

describe.if(existsSync(ASSETS))("the built stylesheet", () => {
  const built = readdirSync(ASSETS)
    .filter((name) => /^app-.*\.css$/.test(name))
    .map((name) => readFileSync(path.join(ASSETS, name), "utf8"))
    .join("\n");

  it("carries no default palette colour and no shadow scale", () => {
    expect(built.length).toBeGreaterThan(0);
    expect(built).not.toMatch(/--color-(red|blue|gray|neutral|slate|zinc|green|amber)-\d/);
    expect(built).not.toMatch(/--shadow-(2xs|xs|sm|md|lg|xl|2xl):/);
  });

  it("loads no resource from another host", () => {
    expect(built).not.toMatch(/url\((["']?)https?:/);
    expect(built).not.toMatch(/@import/);
  });
});
