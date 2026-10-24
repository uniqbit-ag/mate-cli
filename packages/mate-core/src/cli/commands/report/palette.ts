import { BRAND_COLORS } from "../../../brand";

const { ink, mateGreen, cream, lightGreen, night } = BRAND_COLORS;

/**
 * Report colours from the Mate brand kit as CSS custom properties. Light uses Ink on
 * white (Mate green on Cream falls below 4.5:1), dark uses Cream on Night with Light
 * green, and print forces dark text on white whatever the screen scheme.
 */

export interface ReportPalette {
  ink: string;
  bg: string;
  muted: string;
  rule: string;
  accent: string;
  surface: string;
  ok: string;
  warn: string;
  error: string;
  info: string;
  neutral: string;
  addBg: string;
  delBg: string;
  hunkBg: string;
}

/** Colours read as text or markers on `bg`; each must reach 4.5:1 against it. */
export const CONTRAST_TOKENS = [
  "ink",
  "muted",
  "accent",
  "ok",
  "warn",
  "error",
  "info",
  "neutral",
] as const satisfies readonly (keyof ReportPalette)[];

export const LIGHT_PALETTE: ReportPalette = {
  ink: ink.hex,
  bg: "#FFFFFF",
  muted: "#59625E",
  rule: "#E2DED5",
  accent: mateGreen.hex,
  surface: "#F7F5F0",
  ok: mateGreen.hex,
  warn: "#8A5A00",
  error: "#B3261E",
  info: "#2F5F9E",
  neutral: "#66706B",
  addBg: "#E4F3EA",
  delBg: "#FBE8E6",
  hunkBg: "#F1EEE7",
};

export const DARK_PALETTE: ReportPalette = {
  ink: cream.hex,
  bg: night.hex,
  muted: "#A5AEA9",
  rule: "#2D3433",
  accent: lightGreen.hex,
  surface: "#1C2223",
  ok: lightGreen.hex,
  warn: "#E3B45C",
  error: "#F28B82",
  info: "#8DB8F0",
  neutral: "#A5AEA9",
  addBg: "#16382A",
  delBg: "#46211E",
  hunkBg: "#232A2B",
};

export const PRINT_PALETTE: ReportPalette = {
  ...LIGHT_PALETTE,
  ink: "#000000",
  muted: "#444444",
  rule: "#BBBBBB",
  accent: "#1F5C41",
  surface: "#FFFFFF",
};

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function declarations(palette: ReportPalette): string {
  return Object.entries(palette)
    .map(([name, value]) => `--${kebab(name)}: ${value};`)
    .join(" ");
}

export function paletteCss(): string {
  return `:root { color-scheme: light dark; ${declarations(LIGHT_PALETTE)} }
    @media (prefers-color-scheme: dark) { :root { ${declarations(DARK_PALETTE)} } }
    @media print { :root { color-scheme: light; ${declarations(PRINT_PALETTE)} } }`;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2 contrast ratio between two `#RRGGBB` colours. */
export function contrastRatio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].toSorted((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}
