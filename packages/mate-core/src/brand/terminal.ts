import { LOGO_ART } from "./art.generated";
import { BRAND_COLORS } from "./palette";
import type { LogoForm, LogoRow } from "./types";

export interface LogoOptions {
  /** The largest form wanted; it falls back to smaller forms when it does not fit. */
  form: LogoForm;
  /** Columns available on the target stream. */
  columns: number;
  isTTY: boolean;
  env?: Record<string, string | undefined>;
}

export type LogoChoice =
  | { kind: "block"; form: LogoForm; rows: readonly LogoRow[]; color: boolean }
  | { kind: "ascii"; form: LogoForm; rows: readonly string[] }
  | { kind: "word" };

/** The word that stands in for the logo when no art fits. */
export const LOGO_WORD = "mate";

const FALLBACKS: Record<LogoForm, readonly LogoForm[]> = {
  lockup: ["lockup", "symbol"],
  symbol: ["symbol"],
  wordmark: ["wordmark"],
};

function asciiWidth(rows: readonly string[]): number {
  return Math.max(...rows.map((row) => row.length));
}

/** Whether colour is allowed, following https://no-color.org: any non-empty NO_COLOR disables it. */
export function colorEnabled(
  isTTY: boolean,
  env: Record<string, string | undefined> = {},
): boolean {
  return isTTY && !env.NO_COLOR;
}

/**
 * Picks the logo encoding for a stream: block art on a TTY (coloured unless NO_COLOR is set),
 * ASCII otherwise, falling back from the lockup to the symbol to the word `mate` as width runs
 * out.
 */
export function chooseLogo({ form, columns, isTTY, env = {} }: LogoOptions): LogoChoice {
  for (const candidate of FALLBACKS[form]) {
    const art = LOGO_ART[candidate];
    if (!isTTY) {
      if (asciiWidth(art.ascii) <= columns)
        return { kind: "ascii", form: candidate, rows: art.ascii };
    } else if (art.columns <= columns) {
      return { kind: "block", form: candidate, rows: art.block, color: colorEnabled(isTTY, env) };
    }
  }
  return { kind: "word" };
}

function hexToRgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
}

const NOTE_ON = `\x1b[38;2;${hexToRgb(BRAND_COLORS.mateGreen.hex)}m`;
const NOTE_OFF = "\x1b[39m";

/** Renders the logo as a string ready to write to a stream, rows separated by newlines. */
export function renderLogo(options: LogoOptions): string {
  const choice = chooseLogo(options);
  if (choice.kind === "word") return LOGO_WORD;
  if (choice.kind === "ascii") return choice.rows.join("\n");

  return choice.rows
    .map((row) =>
      row
        .map((segment) =>
          choice.color && segment.kind === "note"
            ? `${NOTE_ON}${segment.text}${NOTE_OFF}`
            : segment.text,
        )
        .join(""),
    )
    .join("\n");
}
