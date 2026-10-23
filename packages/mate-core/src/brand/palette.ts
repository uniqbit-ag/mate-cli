/** A brand colour as a 24-bit hex value plus its nearest xterm 256-colour index. */
export interface BrandColor {
  hex: string;
  ansi256: number;
}

/** The five colours of the Mate identity, as defined in `assets/logo-kit/BRAND.md`. */
export const BRAND_COLORS = {
  ink: { hex: "#1F2421", ansi256: 235 },
  mateGreen: { hex: "#2E7D5B", ansi256: 29 },
  cream: { hex: "#F4F0E8", ansi256: 255 },
  lightGreen: { hex: "#7FD0A6", ansi256: 115 },
  night: { hex: "#15191A", ansi256: 234 },
} as const satisfies Record<string, BrandColor>;

export type BrandColorName = keyof typeof BRAND_COLORS;

/** The accent used on surfaces whose background is unknown; it reads on both light and dark. */
export const BRAND_ACCENT = BRAND_COLORS.mateGreen.hex;
