import { endsWord, startsAnsiCQuote } from "./shell-quoting";

// Heredoc reading for the shell reader (`shell-reading.ts`), its only importer. A heuristic:
// when unsure, lines stay command text, so a misread can only make a check read more.

export interface HeredocMarker {
  /** Index just past the marker word. */
  end: number;
  /**
   * The word after quote removal (`<<E"OF"` ends at `EOF`). Null when the reader
   * cannot settle it: empty, a quote unclosed on its line, a `$` or a backtick.
   */
  delimiter: string | null;
}

const METACHARACTER = /[ \t\n;&|()<>]/;

/** The marker at `start`, a `<<` (not `<<<`) outside quotes: an optional `-`, blanks, one word. */
export function heredocMarker(text: string, start: number): HeredocMarker {
  let i = start + 2;
  if (text[i] === "-") i++;
  while (text[i] === " " || text[i] === "\t") i++;
  let delimiter = "";
  let settled = true;
  for (; i < text.length && !METACHARACTER.test(text[i]); i++) {
    const char = text[i];
    if (char === "$" || char === "`") {
      settled = false;
      delimiter += char;
    } else if (char === "\\") {
      if (i + 1 >= text.length || text[i + 1] === "\n") return { end: i + 1, delimiter: null };
      delimiter += text[++i];
    } else if (char === "'" || char === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== char && text[j] !== "\n"; j++) {
        if (char === '"' && (text[j] === "$" || text[j] === "`")) settled = false;
        if (char === '"' && text[j] === "\\" && '"\\$`'.includes(text[j + 1] ?? "")) j++;
        delimiter += text[j];
      }
      if (text[j] !== char) return { end: j, delimiter: null };
      i = j;
    } else {
      delimiter += char;
    }
  }
  return { end: i, delimiter: settled && delimiter !== "" ? delimiter : null };
}

/**
 * In arithmetic `<<` is a shift. `${…}` holds its own quotes (`"${x:-"a"}"`) and
 * no heredoc; `quoted` when inside double quotes, where a `'` is plain.
 */
type Frame =
  | { kind: "command"; closer: ")" | "`" | null; depth: number }
  | { kind: "double" }
  | { kind: "single" }
  | { kind: "ansi" }
  | { kind: "arith"; closer: "))" | "]"; depth: number }
  | { kind: "param"; quoted: boolean; depth: number };

const topLevel = (): Frame[] => [{ kind: "command", closer: null, depth: 0 }];

interface LineScan {
  /** Each `<<` read outside quotes and arithmetic, by column. */
  markers: { column: number; delimiter: string | null }[];
  /** Whether a backslash ends the line, joining it to the next. */
  continued: boolean;
}

/** Advances `stack` across one line; a `#` starting a word in command text hides the rest of it. */
function scanLine(line: string, stack: Frame[]): LineScan {
  const markers: LineScan["markers"] = [];
  let continued = false;
  let wordStart = true;
  const open = (frame: Frame) => stack.push(frame);
  const substitution = (closer: ")" | "`") => {
    open({ kind: "command", closer, depth: 0 });
    wordStart = true;
  };
  for (let i = 0; i < line.length; i++) {
    const frame = stack.at(-1) as Frame;
    const char = line[i];
    const next = line[i + 1];
    const atWordStart = wordStart;
    wordStart = false;
    if (frame.kind === "single") {
      if (char === "'") stack.pop();
    } else if (frame.kind === "ansi") {
      if (char === "\\") i++;
      else if (char === "'") stack.pop();
    } else if (char === "\\") {
      // A backslash escapes the next character in command text, double quotes and arithmetic alike.
      if (i + 1 >= line.length) continued = true;
      i++;
    } else if (char === "$" && next === "{") {
      const quoted = frame.kind === "double" || (frame.kind === "param" && frame.quoted);
      open({ kind: "param", quoted, depth: 0 });
      i++;
    } else if (char === "$" && next === "(" && line[i + 2] === "(") {
      open({ kind: "arith", closer: "))", depth: 0 });
      i += 2;
    } else if (char === "$" && next === "[") {
      open({ kind: "arith", closer: "]", depth: 0 });
      i++;
    } else if (char === "$" && next === "(") {
      substitution(")");
      i++;
    } else if (char === "`" && !(frame.kind === "command" && frame.closer === "`")) {
      substitution("`");
    } else if (frame.kind === "param") {
      if (char === "{") frame.depth++;
      else if (char === "}") {
        if (frame.depth > 0) frame.depth--;
        else stack.pop();
      } else if (char === '"') open({ kind: "double" });
      else if (char === "'" && !frame.quoted) open({ kind: "single" });
    } else if (frame.kind === "double") {
      if (char === '"') stack.pop();
    } else if (frame.kind === "arith") {
      if (char === "(") frame.depth++;
      else if (char === "]" && frame.closer === "]") stack.pop();
      else if (char === ")" && frame.closer === "))") {
        if (frame.depth > 0) frame.depth--;
        else {
          stack.pop();
          if (next === ")") i++;
        }
      } else if (char === '"') open({ kind: "double" });
      else if (char === "'") open({ kind: "single" });
    } else if (char === "#" && atWordStart) {
      break;
    } else if (startsAnsiCQuote(line, i)) {
      open({ kind: "ansi" });
      i++;
    } else if (char === "$" && next === '"') {
      open({ kind: "double" });
      i++;
    } else if (char === "'") {
      open({ kind: "single" });
    } else if (char === '"') {
      open({ kind: "double" });
    } else if ((char === "<" || char === ">") && next === "(") {
      substitution(")");
      i++;
    } else if (char === "(" && next === "(" && atWordStart) {
      open({ kind: "arith", closer: "))", depth: 0 });
      i++;
    } else if (char === "`") {
      // Closes the backtick substitution this frame is.
      stack.pop();
    } else if (char === "(") {
      frame.depth++;
      wordStart = true;
    } else if (char === ")") {
      if (frame.depth > 0) frame.depth--;
      else if (frame.closer === ")") stack.pop();
      wordStart = true;
    } else if (char === "<" && next === "<") {
      if (line[i + 2] === "<") {
        i += 2;
      } else {
        const marker = heredocMarker(line, i);
        markers.push({ column: i, delimiter: marker.delimiter });
        i = marker.delimiter === null ? i + 1 : marker.end - 1;
      }
      wordStart = true;
    } else {
      wordStart = endsWord(char);
    }
  }
  return { markers, continued };
}

/** A heredoc body and where its `<<` sits in the stripped command (`kept` joined with newlines). */
export interface HeredocSplitBody {
  offset: number;
  text: string;
}

/**
 * The command's lines with every heredoc body and terminator line removed,
 * and the bodies, in order; an unterminated body runs to the end. Marker lines
 * stay: a redirect the command performs is spelled there, never in the body
 * it writes. A body is split off only when its marker reads the same on its
 * line read alone, so a quote misjudged earlier cannot turn later lines into
 * a body; otherwise every body of that line stays command text.
 */
export function splitHeredocs(command: string): { kept: string[]; bodies: HeredocSplitBody[] } {
  const lines = command.split("\n");
  const kept: string[] = [];
  /** Where each kept line starts in the stripped command. */
  const keptStarts: number[] = [];
  let keptLength = 0;
  const bodies: HeredocSplitBody[] = [];
  const stack = topLevel();
  let pending: { delimiter: string | null; offset: number }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    keptStarts.push(keptLength);
    keptLength += line.length + 1;
    kept.push(line);
    const scan = scanLine(line, stack);
    if (scan.markers.length > 0) {
      const alone = new Map(
        scanLine(line, topLevel()).markers.map((other) => [other.column, other]),
      );
      for (const marker of scan.markers) {
        const same = alone.get(marker.column);
        pending.push({
          delimiter: same?.delimiter === marker.delimiter ? marker.delimiter : null,
          offset: (keptStarts.at(-1) as number) + marker.column,
        });
      }
    }
    const top = stack.at(-1) as Frame;
    if (pending.length === 0 || scan.continued || top.kind !== "command") continue;
    const markers = pending;
    pending = [];
    if (markers.some((marker) => marker.delimiter === null)) continue;
    for (const marker of markers) {
      const body: string[] = [];
      for (index++; index < lines.length && lines[index].trim() !== marker.delimiter; index++) {
        body.push(lines[index]);
      }
      bodies.push({ offset: marker.offset, text: body.join("\n") });
      if (index >= lines.length) break;
    }
  }
  return { kept, bodies };
}
