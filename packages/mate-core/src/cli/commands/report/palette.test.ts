import { describe, expect, test } from "bun:test";

import { BRAND_COLORS } from "../../../brand";
import {
  CONTRAST_TOKENS,
  DARK_PALETTE,
  LIGHT_PALETTE,
  PRINT_PALETTE,
  contrastRatio,
  paletteCss,
} from "./palette";

describe("report palette", () => {
  test("computes WCAG contrast ratios", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
  });

  test("uses the brand colours for text and accent", () => {
    const { ink, mateGreen, cream, lightGreen, night } = BRAND_COLORS;
    expect(LIGHT_PALETTE).toMatchObject({ ink: ink.hex, accent: mateGreen.hex });
    expect(DARK_PALETTE).toMatchObject({ ink: cream.hex, bg: night.hex, accent: lightGreen.hex });
    expect(PRINT_PALETTE.bg).toBe("#FFFFFF");
  });

  for (const [name, palette] of [
    ["light", LIGHT_PALETTE],
    ["dark", DARK_PALETTE],
    ["print", PRINT_PALETTE],
  ] as const) {
    test(`every text and accent colour reaches 4.5:1 in the ${name} scheme`, () => {
      for (const token of CONTRAST_TOKENS) {
        for (const background of [palette.bg, palette.surface]) {
          expect({ token, ratio: contrastRatio(palette[token], background) >= 4.5 }).toEqual({
            token,
            ratio: true,
          });
        }
      }
    });
  }

  test("switches tokens by colour scheme and forces light print", () => {
    const css = paletteCss();

    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(`--bg: ${BRAND_COLORS.night.hex};`);
    expect(css).toContain("@media print { :root { color-scheme: light;");
    expect(css).toContain("--add-bg:");
  });
});
