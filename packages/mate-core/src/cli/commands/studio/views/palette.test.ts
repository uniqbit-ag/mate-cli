import { describe, expect, it } from "bun:test";

import { DARK_PALETTE, LIGHT_PALETTE, contrastRatio } from "../../report/palette";
import {
  STUDIO_DARK_PALETTE,
  STUDIO_LIGHT_PALETTE,
  STUDIO_TEXT_TOKENS,
  type StudioPalette,
  TINT_PERCENT,
  studioPaletteCss,
} from "./palette";
import { STUDIO_STYLES } from "./styles";

const APPEARANCES = [
  ["light", STUDIO_LIGHT_PALETTE],
  ["dark", STUDIO_DARK_PALETTE],
] as const;

/** `color-mix(in srgb, <color> <percent>%, <base>)` for two `#RRGGBB` colours. */
function mix(color: string, base: string, percent: number): string {
  const share = percent / 100;
  const channels = [1, 3, 5].map((start) => {
    const value = (hex: string) => Number.parseInt(hex.slice(start, start + 2), 16);
    return Math.round(value(color) * share + value(base) * (1 - share));
  });
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

const camel = (token: string): keyof StudioPalette =>
  token.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) as keyof StudioPalette;

/** Resolves a `var(--x)` or `var(--x-soft)` reference to a concrete colour of one appearance. */
function resolve(reference: string, palette: StudioPalette): string | undefined {
  const name = reference.match(/^var\(--([a-z-]+)\)$/)?.[1];
  if (!name) return undefined;
  if (name.endsWith("-soft")) {
    const base = palette[camel(name.slice(0, -"-soft".length))];
    return base?.startsWith("#") ? mix(base, palette.panel, TINT_PERCENT) : undefined;
  }
  const value = palette[camel(name)];
  return value?.startsWith("#") ? value : undefined;
}

describe("studio palette", () => {
  it("builds both appearances from the report palette", () => {
    expect(STUDIO_LIGHT_PALETTE).toMatchObject({
      bg: LIGHT_PALETTE.bg,
      panel: LIGHT_PALETTE.surface,
      panelSoft: LIGHT_PALETTE.bg,
      text: LIGHT_PALETTE.ink,
      accent: LIGHT_PALETTE.accent,
      done: LIGHT_PALETTE.ok,
      info: LIGHT_PALETTE.info,
    });
    expect(STUDIO_DARK_PALETTE).toMatchObject({
      bg: DARK_PALETTE.bg,
      panel: DARK_PALETTE.surface,
      panelSoft: DARK_PALETTE.bg,
      text: DARK_PALETTE.ink,
      accent: DARK_PALETTE.accent,
      done: DARK_PALETTE.ok,
      info: DARK_PALETTE.info,
    });
  });

  it("keeps dark as the default and lets an explicit theme win over the system", () => {
    const css = studioPaletteCss();

    expect(css).toStartWith(`:root {\n  color-scheme: dark;\n  --bg: ${DARK_PALETTE.bg};`);
    expect(css).toContain(
      `@media (prefers-color-scheme: light) {\n  :root:not([data-theme="dark"]) {\n    color-scheme: light;\n    --bg: ${LIGHT_PALETTE.bg};`,
    );
    expect(css).toContain(
      `:root[data-theme="light"] {\n  color-scheme: light;\n  --bg: ${LIGHT_PALETTE.bg};`,
    );
    expect(css).toContain(':root[data-theme="dark"] {\n  color-scheme: dark;\n}');
    expect(css).toContain(
      `--accent-soft: color-mix(in srgb, var(--accent) ${TINT_PERCENT}%, var(--panel));`,
    );
  });

  it("declares no colour literal inside the stylesheet's own token blocks", () => {
    const own = STUDIO_STYLES.replace(studioPaletteCss(), "");
    expect(own).not.toMatch(/--[a-z-]+:\s*(#|rgb)/);
  });

  for (const [name, palette] of APPEARANCES) {
    it(`reaches 4.5:1 for every text and status colour on the ${name} page and cards`, () => {
      for (const token of STUDIO_TEXT_TOKENS) {
        for (const background of [palette.bg, palette.panel]) {
          const ratio = contrastRatio(palette[token], background);
          expect({ token, background, passes: ratio >= 4.5 }).toEqual({
            token,
            background,
            passes: true,
          });
        }
      }
    });

    it(`keeps text on accent fills and the vault editor legible in ${name}`, () => {
      expect(contrastRatio(palette.onAccent, palette.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.onAccent, palette.done)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.promptText, palette.promptBg)).toBeGreaterThanOrEqual(4.5);
    });

    it(`keeps every coloured text legible on the tint drawn behind it in ${name}`, () => {
      // Pairs set within one rule: `color` (or a badge's `--badge-text`) over `background`
      // (or `--badge-soft`). A token that fails on its own tint must switch to --text.
      for (const rule of STUDIO_STYLES.split("}")) {
        const foreground = rule.match(/(?:[^-]color|--badge-text):\s*(var\(--[a-z-]+\))/)?.[1];
        const background = rule.match(
          /(?:background|--badge-soft):\s*(var\(--[a-z-]+-soft\))/,
        )?.[1];
        if (!foreground || !background) continue;
        const fg = resolve(foreground, palette);
        const bg = resolve(background, palette);
        if (!fg || !bg) continue;
        const selector = rule.slice(0, rule.indexOf("{")).trim().split("\n").at(-1);
        expect({ selector, foreground, background, passes: contrastRatio(fg, bg) >= 4.5 }).toEqual({
          selector,
          foreground,
          background,
          passes: true,
        });
      }
    });
  }
});
