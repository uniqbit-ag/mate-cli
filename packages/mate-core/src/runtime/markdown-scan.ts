/**
 * A line scan of CommonMark, deep enough to find `##` sections, fenced code
 * and block-level HTML comments as Claude Code's memory loading reads them.
 */

/** A block quote, or a list item whose content starts `width` columns into its parent's. */
type Container = { kind: "quote" } | { kind: "item"; width: number };

interface Fence {
  char: string;
  length: number;
  /** The containers the fence opened in, outermost first; a line that leaves one ends the fence. */
  containers: readonly Container[];
}

const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;
const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])/;
const BLANK = /^[ \t]*$/;

function indentation(text: string, from: number): { column: number; rest: string } {
  let column = from;
  let index = 0;
  for (; index < text.length; index++) {
    if (text[index] === " ") column++;
    else if (text[index] === "\t") column += 4 - (column % 4);
    else break;
  }
  return { column, rest: text.slice(index) };
}

/** Where a line's text stands: `rest` starts at `column`; the innermost container's content starts at `base`. */
interface Position {
  column: number;
  rest: string;
  base: number;
}

/** CommonMark: `>` after up to three spaces of indentation, and one optional space that belongs to the marker. */
function afterQuoteMarker({ column, rest, base }: Position): Position | null {
  if (column - base > 3 || !rest.startsWith(">")) return null;
  const marker = column + 1;
  const after = indentation(rest.slice(1), marker);
  return { ...after, base: after.column > marker ? marker + 1 : marker };
}

/** The open containers a line continues, outermost first. A blank line continues list items, never a quote. */
function continueContainers(
  line: string,
  containers: readonly Container[],
): { matched: Container[]; at: Position } {
  let at: Position = { ...indentation(line, 0), base: 0 };
  const matched: Container[] = [];
  for (const container of containers) {
    if (container.kind === "quote") {
      const next = afterQuoteMarker(at);
      if (!next) break;
      at = next;
    } else {
      if (at.rest !== "" && at.column < at.base + container.width) break;
      at = { ...at, base: at.base + container.width };
    }
    matched.push(container);
  }
  return { matched, at };
}

/** The open containers carried from line to line. */
interface ContainerContext {
  containers: readonly Container[];
  /** A paragraph is open, so a line that leaves its containers may continue it lazily. */
  paragraph: boolean;
  /** The innermost item opened on a blank line, so a blank line next ends it. */
  emptyItem: boolean;
}

const TOP_LEVEL: ContainerContext = { containers: [], paragraph: false, emptyItem: false };

/** CommonMark: a line that starts a block, so it ends a paragraph rather than continuing it. */
const INTERRUPTS = /^(?:`{3,}|~{3,}|#{1,6}(?:[ \t]|$)|>|<!--|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * Tracks only as much of CommonMark's block quotes and list items as placing a
 * fence needs. A backtick fence's info string may hold no backtick, so
 * ```` ```a``` ```` is inline code.
 */
function lineBlock(
  line: string,
  context: ContainerContext,
): { fence: Fence | null; context: ContainerContext } {
  const { matched, at } = continueContainers(line, context.containers);
  const continues = matched.length === context.containers.length;
  let { column, rest, base } = at;
  if (rest === "") {
    const containers = continues && context.emptyItem ? matched.slice(0, -1) : matched;
    return { fence: null, context: { containers, paragraph: false, emptyItem: false } };
  }
  if (!continues) {
    const starts = INTERRUPTS.test(rest) || THEMATIC_BREAK.test(rest);
    const lazy = context.paragraph && !(column - base <= 3 && starts);
    if (lazy) return { fence: null, context };
  }
  let containers = matched;
  let paragraph = context.paragraph && continues;

  while (column - base <= 3 && !THEMATIC_BREAK.test(rest)) {
    const quoted = afterQuoteMarker({ column, rest, base });
    if (quoted) {
      containers = [...containers, { kind: "quote" }];
      ({ column, rest, base } = quoted);
      paragraph = false;
      if (rest === "") return { fence: null, context: { containers, paragraph, emptyItem: false } };
      continue;
    }
    const marker = LIST_MARKER.exec(rest);
    if (!marker) break;
    const markerEnd = column + marker[0].length;
    const after = indentation(rest.slice(marker[0].length), markerEnd);
    const gap = after.column - markerEnd;
    if (gap < 1 && after.rest !== "") break;
    const ordered = marker[0].length > 1;
    if (paragraph && (after.rest === "" || (ordered && Number.parseInt(marker[0], 10) !== 1))) {
      break;
    }
    const content = gap > 4 || after.rest === "" ? markerEnd + 1 : after.column;
    containers = [...containers, { kind: "item", width: content - base }];
    base = content;
    paragraph = false;
    if (after.rest === "") {
      return { fence: null, context: { containers, paragraph, emptyItem: true } };
    }
    column = after.column;
    rest = after.rest;
  }

  if (column - base > 3) {
    return { fence: null, context: { containers, paragraph, emptyItem: false } };
  }
  const match = FENCE_OPEN.exec(rest);
  const run = match?.[1];
  if (run && !(run.startsWith("`") && match[2]!.includes("`"))) {
    const fence = { char: run[0]!, length: run.length, containers };
    return { fence, context: { containers, paragraph: false, emptyItem: false } };
  }
  paragraph = !THEMATIC_BREAK.test(rest) && !/^#{1,6}(?:[ \t]|$)/.test(rest);
  return { fence: null, context: { containers, paragraph, emptyItem: false } };
}

/** `ends`: a line that leaves one of the fence's containers ends it; fenced code never continues lazily. */
function fenceLine(line: string, fence: Fence): "content" | "close" | "ends" {
  const { matched, at } = continueContainers(line, fence.containers);
  if (matched.length < fence.containers.length) return "ends";
  if (at.rest === "") return "content";
  const match = at.column - at.base <= 3 ? FENCE_CLOSE.exec(at.rest) : null;
  return match !== null && match[1]!.startsWith(fence.char) && match[1]!.length >= fence.length
    ? "close"
    : "content";
}

/** CommonMark: an ATX heading may be indented by up to three spaces, and be empty. */
const HEADING = /^ {0,3}##(?:[ \t]+(.*))?$/;
/** CommonMark: a closing run of `#`s, after a space or tab, is no part of the heading. */
const CLOSING_SEQUENCE = /(?:^|[ \t]+)#+[ \t]*$/;

function headingText(line: string): string | null {
  const match = HEADING.exec(line);
  if (!match) return null;
  return (match[1] ?? "").replace(CLOSING_SEQUENCE, "").trim();
}

export interface ScannedLine {
  text: string;
  /** The heading text, `""` when empty, when the line opens a top-level (`##`) section: outside fenced code, list items and block quotes, whose scope it would otherwise leave. */
  heading: string | null;
  /** Inside fenced code, where blank lines are content. */
  fenced: boolean;
  /** Where the source line starts in the scanned text. */
  offset: number;
}

/** CommonMark: an HTML block opens on a line that begins, after up to three spaces, with `<!--`. */
const BLOCK_COMMENT_OPEN = /^ {0,3}<!--/;
/** Claude Code's own pattern for the comments it removes from such a block. */
const CLOSED_COMMENT = /<!--[\s\S]*?-->/g;

type ScanState = { in: "prose" } | { in: "fence"; fence: Fence } | { in: "comment" };

const PROSE: ScanState = { in: "prose" };
const COMMENT: ScanState = { in: "comment" };

/**
 * Strips block-level HTML comments as Claude Code's memory loading does: only
 * an HTML block that opens with `<!--` and holds a `-->`, so a `<!--` inside
 * prose, inside fenced code, or never closed stays. The rest of a closing line
 * is still part of the HTML block, so it opens no heading and no fence.
 */
export function scanLinesWithoutComments(text: string): ScannedLine[] {
  const lines: ScannedLine[] = [];
  let state = PROSE;
  let list = TOP_LEVEL;
  let offset = 0;

  const emit = (line: string): void => {
    const next = lineBlock(line, list);
    const heading = next.context.containers.length === 0 ? headingText(line) : null;
    lines.push({ text: line, heading, fenced: false, offset });
    list = next.context;
    state = next.fence ? { in: "fence", fence: next.fence } : PROSE;
  };
  /** A comment's lines are one HTML block: it ends the containers it leaves. */
  const enterComment = (line: string): void => {
    list = { ...lineBlock(line, list).context, paragraph: false };
  };
  const emitAfterClose = (line: string, close: number): void => {
    const rest = line.slice(close + 3).replace(CLOSED_COMMENT, "");
    lines.push({ text: rest, heading: null, fenced: false, offset });
    state = PROSE;
  };

  for (const raw of text.split("\n")) {
    const inFence = state.in === "fence" ? fenceLine(raw, state.fence) : "ends";
    if (inFence !== "ends") {
      lines.push({ text: raw, heading: null, fenced: true, offset });
      if (inFence === "close") state = PROSE;
    } else if (state.in === "comment") {
      const close = raw.indexOf("-->");
      if (close !== -1) emitAfterClose(raw, close);
    } else if (BLOCK_COMMENT_OPEN.test(raw)) {
      const close = text.indexOf("-->", offset + raw.indexOf("<!--") + 4);
      if (close === -1) emit(raw);
      else {
        enterComment(raw);
        if (close < offset + raw.length) emitAfterClose(raw, close - offset);
        else state = COMMENT;
      }
    } else {
      emit(raw);
    }
    offset += raw.length + 1;
  }
  return lines;
}

/** Offsets `[start, end)` of the lines inside fenced code. */
export function fencedRanges(text: string): [number, number][] {
  return scanLinesWithoutComments(text)
    .filter((line) => line.fenced)
    .map((line) => [line.offset, line.offset + line.text.length]);
}

export function joinLines(lines: readonly ScannedLine[]): string {
  const kept: string[] = [];
  let afterBlank = false;
  for (const line of lines) {
    const blank = !line.fenced && BLANK.test(line.text);
    if (!(blank && afterBlank)) kept.push(blank ? "" : line.text);
    afterBlank = blank;
  }
  return trimBlankLines(kept.join("\n"));
}

/** Drops the blank lines around a text but no indentation: an indented fence opener keeps its meaning. */
export function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}
