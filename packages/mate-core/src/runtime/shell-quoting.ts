// Bash quoting rules shared by every guard shell reader, so they read a command the same way.

/** Bash removes the backslash only before `$`, a backtick, `"`, `\` and a newline (`"pub\lic"` is `pub\lic`). */
export function escapedInDoubleQuotes(next: string | undefined): boolean {
  return next !== undefined && next.length === 1 && '$`"\\\n'.includes(next);
}

/** A `#` after one of these starts a comment; elsewhere (`a#b`, `$#`) it is part of a word. */
const WORD_BOUNDARY = /[ \t\r\n;&|()<>]/;

export function endsWord(char: string): boolean {
  return WORD_BOUNDARY.test(char);
}

/** Index of the newline that ends a comment starting at `start`, or the text's end. */
export function commentEnd(text: string, start: number): number {
  const end = text.indexOf("\n", start);
  return end === -1 ? text.length : end;
}

/** Each substitution level recurses, so a crafted command cannot exhaust the stack (Node's is smaller than Bun's). */
export const MAX_SHELL_NESTING = 64;

export class ShellNestingError extends Error {}

export function checkNesting(level: number): void {
  if (level > MAX_SHELL_NESTING) throw new ShellNestingError();
}

/** Index of the `'` closing a single-quoted string opened at `start`, or the text's end. */
export function singleQuoteEnd(text: string, start: number): number {
  const end = text.indexOf("'", start + 1);
  return end === -1 ? text.length : end;
}

/** Index of the backtick closing the one at `start`, skipping escaped characters. */
export function backtickEnd(text: string, start: number): number {
  let i = start + 1;
  for (; i < text.length && text[i] !== "`"; i++) if (text[i] === "\\") i++;
  return i;
}

/**
 * A backtick substitution's command as Bash runs it: inside backticks, `\\`,
 * `` \` `` and `\$` lose one escape layer before the command is read, so an
 * escaped backtick there opens a nested substitution.
 */
export function backtickCommand(inner: string): string {
  return inner.replaceAll(/\\([\\`$])/g, "$1");
}

/** `level` is the substitution level of the string. */
function doubleQuoteEnd(text: string, start: number, level: number): number {
  let i = start + 1;
  for (; i < text.length && text[i] !== '"'; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "$" && text[i + 1] === "(") i = parenEnd(text, i + 1, level + 1);
    else if (text[i] === "`") i = backtickEnd(text, i);
  }
  return i;
}

/**
 * Index of the `)` closing the `(` at `start`, or the text's end. A `#` starting
 * a word hides the rest of its line, a `)` included. `level` is the level the
 * parenthesis opens; past {@link MAX_SHELL_NESTING} it throws {@link ShellNestingError}.
 */
export function parenEnd(text: string, start: number, level: number): number {
  checkNesting(level);
  let depth = 0;
  let wordStart = true;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    const atWordStart = wordStart;
    wordStart = endsWord(char);
    if (char === "\\") i++;
    else if (char === "#" && atWordStart) i = commentEnd(text, i) - 1;
    else if (startsAnsiCQuote(text, i)) i = ansiCQuote(text, i).end;
    else if (char === "'") i = singleQuoteEnd(text, i);
    else if (char === '"') i = doubleQuoteEnd(text, i, level);
    else if (char === "`") i = backtickEnd(text, i);
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return i;
  }
  return text.length;
}

export function startsAnsiCQuote(text: string, index: number): boolean {
  return text[index] === "$" && text[index + 1] === "'";
}

const ANSI_C_ESCAPES: Readonly<Record<string, string>> = {
  a: "\u0007",
  b: "\b",
  e: "\u001b",
  E: "\u001b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

const ANSI_C_HEX_DIGITS: Readonly<Record<string, RegExp>> = {
  x: /^[\da-f]{1,2}/i,
  u: /^[\da-f]{1,4}/i,
  U: /^[\da-f]{1,8}/i,
};

/**
 * `$'…'` at `start`, decoded to the word Bash passes on; an unknown escape stays
 * as written. A decoded NUL ends the value, as Bash keeps a C string (`$'a\0b'c` is `ac`).
 */
export function ansiCQuote(text: string, start: number): { value: string; end: number } {
  const decoded = ansiCDecode(text, start);
  const nul = decoded.value.indexOf("\0");
  return nul === -1 ? decoded : { value: decoded.value.slice(0, nul), end: decoded.end };
}

function ansiCDecode(text: string, start: number): { value: string; end: number } {
  let value = "";
  let i = start + 2;
  for (; i < text.length && text[i] !== "'"; i++) {
    if (text[i] !== "\\" || i + 1 >= text.length) {
      value += text[i];
      continue;
    }
    const next = text[++i];
    const rest = text.slice(i + 1);
    const digits = (pattern: RegExp) => pattern.exec(rest)?.[0] ?? "";
    if (next in ANSI_C_ESCAPES) {
      value += ANSI_C_ESCAPES[next];
    } else if (/[0-7]/.test(next)) {
      const octal = next + digits(/^[0-7]{0,2}/);
      value += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
      i += octal.length - 1;
    } else if (next in ANSI_C_HEX_DIGITS) {
      const hex = digits(ANSI_C_HEX_DIGITS[next]);
      const code = Number.parseInt(hex, 16);
      if (!hex || code > 0x10ffff) value += `\\${next}`;
      else value += String.fromCodePoint(code);
      i += hex.length;
    } else if (next === "c" && i + 1 < text.length) {
      value += String.fromCharCode(text[++i].charCodeAt(0) & 0x1f);
    } else {
      value += `\\${next}`;
    }
  }
  return { value, end: i };
}
