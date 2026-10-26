import { DARK_PALETTE, LIGHT_PALETTE, type ReportPalette } from "../../report/palette";

/**
 * Studio's colour tokens, built from the report palette so Studio and its hosted
 * reports share the Mate brand colours. Token names stay Studio's own; the values
 * come from `ReportPalette`, plus Studio-only label colours for workflow badges.
 */

export interface StudioPalette {
  bg: string;
  bgRail: string;
  panel: string;
  /** Nested boxes inside a card: the page colour keeps light accent text at 5:1. */
  panelSoft: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  done: string;
  warn: string;
  bad: string;
  info: string;
  what: string;
  why: string;
  /** Text drawn on an accent or success fill (toast, nav badge). */
  onAccent: string;
  promptBg: string;
  promptText: string;
  /** Only the off-canvas terminal drawer floats over the page. */
  drawerShadow: string;
}

/** Colours read as text or status markers; each must reach 4.5:1 on the page and on cards. */
export const STUDIO_TEXT_TOKENS = [
  "text",
  "muted",
  "accent",
  "done",
  "warn",
  "bad",
  "info",
  "what",
  "why",
] as const satisfies readonly (keyof StudioPalette)[];

/** Each of these also gets a `--<name>-soft` tint: this share of the colour over the card surface. */
const TINTED_TOKENS = [
  "accent",
  "done",
  "warn",
  "bad",
  "info",
  "what",
  "why",
] as const satisfies readonly (keyof StudioPalette)[];

export const TINT_PERCENT = 12;

function fromReport(
  report: ReportPalette,
  studio: Pick<StudioPalette, "what" | "why" | "onAccent" | "drawerShadow">,
): StudioPalette {
  return {
    bg: report.bg,
    bgRail: report.surface,
    panel: report.surface,
    panelSoft: report.bg,
    border: report.rule,
    text: report.ink,
    muted: report.muted,
    accent: report.accent,
    done: report.ok,
    warn: report.warn,
    bad: report.error,
    info: report.info,
    promptBg: report.bg,
    promptText: report.ink,
    ...studio,
  };
}

export const STUDIO_LIGHT_PALETTE = fromReport(LIGHT_PALETTE, {
  what: "#176B75",
  why: "#6346A5",
  onAccent: "#FFFFFF",
  drawerShadow: "0 12px 32px rgb(31 36 33 / 12%)",
});

export const STUDIO_DARK_PALETTE = fromReport(DARK_PALETTE, {
  what: "#74D3D8",
  why: "#CAA8FF",
  onAccent: DARK_PALETTE.bg,
  drawerShadow: "0 14px 36px rgb(0 0 0 / 40%)",
});

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function declarations(palette: StudioPalette, indent: string): string {
  const lines = Object.entries(palette).map(([name, value]) => `--${kebab(name)}: ${value};`);
  lines.push("--border-soft: color-mix(in srgb, var(--border) 55%, var(--panel));");
  for (const token of TINTED_TOKENS) {
    lines.push(
      `--${token}-soft: color-mix(in srgb, var(--${token}) ${TINT_PERCENT}%, var(--panel));`,
    );
  }
  return lines.map((line) => `${indent}${line}`).join("\n");
}

/**
 * Dark is the default; light applies through the system preference or the in-page
 * toggle, and an explicit `data-theme` wins over the media query in both directions.
 */
export function studioPaletteCss(): string {
  return `:root {
  color-scheme: dark;
${declarations(STUDIO_DARK_PALETTE, "  ")}
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    color-scheme: light;
${declarations(STUDIO_LIGHT_PALETTE, "    ")}
  }
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { color-scheme: dark; }
}
:root[data-theme="light"] {
  color-scheme: light;
${declarations(STUDIO_LIGHT_PALETTE, "  ")}
}
:root[data-theme="dark"] {
  color-scheme: dark;
}`;
}
