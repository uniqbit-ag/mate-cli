/**
 * A line scan of CommonMark, deep enough to find `##` sections, fenced code
 * and block-level HTML comments as Claude Code's memory loading reads them.
 */

interface Fence {
  char: string;
  length: number;
  /** The content column of the list items the fence opened in; 0 at the top level. */
  indent: number;
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

/** The open list items' content columns, innermost last, carried from line to line. */
interface ListContext {
  items: readonly number[];
  /** A paragraph is open, so a less indented line may continue it lazily. */
  paragraph: boolean;
  /** The innermost item opened on a blank line, so a blank line next ends it. */
  emptyItem: boolean;
}

const TOP_LEVEL: ListContext = { items: [], paragraph: false, emptyItem: false };

/** CommonMark: a line that starts a block, so it ends a paragraph rather than continuing it. */
const INTERRUPTS = /^(?:`{3,}|~{3,}|#{1,6}(?:[ \t]|$)|>|<!--|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * Tracks only as much of CommonMark's list items as placing a fence needs. A
 * backtick fence's info string may hold no backtick, so ```` ```a``` ```` is
 * inline code.
 */
function lineBlock(
  line: string,
  context: ListContext,
): { fence: Fence | null; context: ListContext } {
  if (BLANK.test(line)) {
    const items = context.emptyItem ? context.items.slice(0, -1) : context.items;
    return { fence: null, context: { items, paragraph: false, emptyItem: false } };
  }
  let { column, rest } = indentation(line, 0);
  let items = context.items.filter((content) => content <= column);
  let base = items.at(-1) ?? 0;
  if (items.length < context.items.length) {
    const starts = INTERRUPTS.test(rest) || THEMATIC_BREAK.test(rest);
    const lazy = context.paragraph && !(column - base <= 3 && starts);
    if (lazy) return { fence: null, context };
  }
  let paragraph = context.paragraph && items.length === context.items.length;

  while (column - base <= 3 && !THEMATIC_BREAK.test(rest)) {
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
    items = [...items, content];
    base = content;
    paragraph = false;
    if (after.rest === "") return { fence: null, context: { items, paragraph, emptyItem: true } };
    column = after.column;
    rest = after.rest;
  }

  if (column - base > 3) {
    return { fence: null, context: { items, paragraph, emptyItem: false } };
  }
  const match = FENCE_OPEN.exec(rest);
  const run = match?.[1];
  if (run && !(run.startsWith("`") && match[2]!.includes("`"))) {
    const fence = { char: run[0]!, length: run.length, indent: base };
    return { fence, context: { items, paragraph: false, emptyItem: false } };
  }
  paragraph = !THEMATIC_BREAK.test(rest) && !/^#{1,6}(?:[ \t]|$)/.test(rest);
  return { fence: null, context: { items, paragraph, emptyItem: false } };
}

/** `ends`: a line indented less than the list item's content ends the item, and the fence with it. */
function fenceLine(line: string, fence: Fence): "content" | "close" | "ends" {
  if (BLANK.test(line)) return "content";
  const { column, rest } = indentation(line, 0);
  if (column < fence.indent) return "ends";
  const match = column - fence.indent <= 3 ? FENCE_CLOSE.exec(rest) : null;
  return match !== null && match[1]!.startsWith(fence.char) && match[1]!.length >= fence.length
    ? "close"
    : "content";
}

/** CommonMark: an ATX heading may be indented by up to three spaces. */
const HEADING = /^ {0,3}##(?!#)\s+(.*\S)\s*$/;

export interface ScannedLine {
  text: string;
  /** The heading text when the line opens a top-level (`##`) section: outside fenced code, and outside list items, whose scope it would otherwise leave. */
  heading: string | null;
  /** Inside fenced code, where blank lines are content. */
  fenced: boolean;
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
export function scanLines(text: string): ScannedLine[] {
  const lines: ScannedLine[] = [];
  let state = PROSE;
  let list = TOP_LEVEL;
  let offset = 0;

  const emit = (line: string): void => {
    const next = lineBlock(line, list);
    const heading = next.context.items.length === 0 ? (HEADING.exec(line)?.[1] ?? null) : null;
    lines.push({ text: line, heading, fenced: false });
    list = next.context;
    state = next.fence ? { in: "fence", fence: next.fence } : PROSE;
  };
  /** A comment's lines are one HTML block: it ends the list items it is indented less than. */
  const enterComment = (line: string): void => {
    list = { ...lineBlock(line, list).context, paragraph: false };
  };
  const emitAfterClose = (line: string, close: number): void => {
    const rest = line.slice(close + 3).replace(CLOSED_COMMENT, "");
    lines.push({ text: rest, heading: null, fenced: false });
    state = PROSE;
  };

  for (const raw of text.split("\n")) {
    const inFence = state.in === "fence" ? fenceLine(raw, state.fence) : "ends";
    if (inFence !== "ends") {
      lines.push({ text: raw, heading: null, fenced: true });
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

export function joinLines(lines: readonly ScannedLine[]): string {
  const kept: string[] = [];
  let afterBlank = false;
  for (const line of lines) {
    const blank = !line.fenced && BLANK.test(line.text);
    if (!(blank && afterBlank)) kept.push(blank ? "" : line.text);
    afterBlank = blank;
  }
  return kept.join("\n").trim();
}
