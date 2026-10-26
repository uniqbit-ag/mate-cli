/**
 * What a run of logo cells belongs to. Notes are the three bars of the right pane and the
 * only cells coloured on an unknown background; panes and the wordmark keep the default
 * foreground.
 */
export type LogoSegmentKind = "pane" | "note" | "word";

/** A run of adjacent cells that share a kind. Spaces between runs are their own segments. */
export interface LogoSegment {
  kind: LogoSegmentKind | "space";
  text: string;
}

export type LogoRow = readonly LogoSegment[];

/** One logo form in every terminal encoding the kit provides. */
export interface LogoArt {
  /** Unicode half-block art, one entry per row. */
  readonly block: readonly LogoRow[];
  /** 7-bit ASCII art for streams that are not a TTY. */
  readonly ascii: readonly string[];
  /** Width in columns of the block art. */
  readonly columns: number;
}

export type LogoForm = "lockup" | "symbol" | "wordmark";

/** The SVG markup a web surface embeds, generated verbatim from the kit. */
export interface BrandSvgs {
  readonly symbolColor: string;
  readonly symbolOnDark: string;
  readonly favicon: string;
}
