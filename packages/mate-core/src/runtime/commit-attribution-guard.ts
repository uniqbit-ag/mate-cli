import path from "node:path";

import { heredocBodies, stripHeredocBodies } from "./shell-heredoc";

const CO_AUTHOR_TRAILER = /^\s*co-authored-by\s*[:=]\s*(.+)$/gim;
/** Substrings, not words: `ChatGPT` and `claude_bot` mention a model too. */
const MODEL_NAME = /claude|anthropic|gpt|openai|codex|gemini|copilot|opencode/i;

/** `git` options before the subcommand that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c"]);
/** `git commit` short options whose value is the next word, or the rest of the cluster. */
const COMMIT_VALUE_SHORTS = new Set(["m", "F", "t", "c", "C"]);
/** Words that run the command after them, with their own dash options. */
const COMMAND_WRAPPERS = new Set(["env", "sudo", "command", "exec", "nice", "nohup", "time"]);
/** Characters a backslash escapes inside double quotes; before any other it stays. */
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);

const SEPARATOR = Symbol("separator");
/** A word and the first and last lines it spans. */
interface Word {
  text: string;
  start: number;
  end: number;
}
type Token = Word | typeof SEPARATOR;

/** One simple command's words and the lines it spans. */
interface Segment {
  words: string[];
  start: number;
  end: number;
}

/**
 * Shell words and command separators (`&&`, `||`, `;`, `|`, `&`, parentheses,
 * newline), quotes removed. A quoted string stays one word across lines, so a
 * multi-line `-m` message is one value. A heuristic, not a parser.
 */
function shellTokens(command: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let quote: string | undefined;
  let quoted = false;
  let line = 0;
  let start = 0;
  const markStart = () => {
    if (!word && !quoted) start = line;
  };
  const append = (text: string) => {
    markStart();
    word += text;
  };
  const flush = () => {
    if (word || quoted) tokens.push({ text: word, start, end: line });
    word = "";
    quoted = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && DOUBLE_QUOTE_ESCAPES.has(command[i + 1] ?? "")) {
        append(command[++i]);
      } else append(char);
    } else if (char === "'" || char === '"') {
      markStart();
      quote = char;
      quoted = true;
    } else if (char === "\\" && i + 1 < command.length) {
      if (command[i + 1] !== "\n") append(command[i + 1]);
      i++;
    } else if (";|&\n()".includes(char)) {
      flush();
      if (tokens.at(-1) !== SEPARATOR) tokens.push(SEPARATOR);
    } else if (/\s/.test(char)) {
      flush();
    } else {
      append(char);
    }
    if (command[i] === "\n") line++;
  }
  flush();
  return tokens;
}

function segments(tokens: Token[]): Segment[] {
  const result: Segment[] = [];
  let current: Segment | undefined;
  for (const token of tokens) {
    if (token === SEPARATOR) {
      current = undefined;
    } else if (current) {
      current.words.push(token.text);
      current.end = token.end;
    } else {
      current = { words: [token.text], start: token.start, end: token.end };
      result.push(current);
    }
  }
  return result;
}

/** The words after `git commit`, or null when the segment runs something else. */
function commitArguments(segment: Segment): string[] | null {
  const words = segment.words;
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (COMMAND_WRAPPERS.has(word) || word === "{" || word === "!" || /^\w+=/.test(word)) i++;
    else if (i > 0 && COMMAND_WRAPPERS.has(words[i - 1]) && word.startsWith("-")) i++;
    else break;
  }
  if (i >= words.length || path.basename(words[i]) !== "git") return null;
  i++;
  while (i < words.length && words[i].startsWith("-")) {
    i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  return words[i] === "commit" ? words.slice(i + 1) : null;
}

/**
 * Message text the arguments carry: `-m x`, `-mx`, `-am x`, `--message=x` and
 * `--message x` values, plus each `--trailer` value as a trailer line.
 */
function messageValues(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "--message" || arg === "--trailer") {
      if (i + 1 < args.length) values.push(args[++i]);
    } else if (arg.startsWith("--message=") || arg.startsWith("--trailer=")) {
      values.push(arg.slice(arg.indexOf("=") + 1));
    } else if (/^-[^-]/.test(arg)) {
      for (let j = 1; j < arg.length; j++) {
        if (!COMMIT_VALUE_SHORTS.has(arg[j])) continue;
        const rest = arg.slice(j + 1);
        const value = rest || args[++i];
        if (arg[j] === "m" && value !== undefined) values.push(value);
        break;
      }
    }
  }
  return values;
}

/** Whether a trailer credits a model; a literal `\n`, as `printf` or `$'…'` expand it, counts as a line break. */
function creditsModel(text: string): boolean {
  for (const trailer of text.replace(/\\n/g, "\n").matchAll(CO_AUTHOR_TRAILER)) {
    if (MODEL_NAME.test(trailer[1])) return true;
  }
  return false;
}

const REFUSAL = [
  "Mate guardrail: Co-Authored-By trailers that credit an AI model are not allowed in this repository.",
  "No commit was created. Rerun the same commit without the Co-Authored-By trailer; do not amend or rewrite history to remove it.",
].join("\n");

/**
 * Returns the refusal for a shell command running `git commit` whose message
 * credits an AI model as co-author, or null. Reads only message text in the
 * command: `-m`/`--message`/`--trailer` values and the heredoc bodies a commit
 * reads, those whose marker sits on a line the commit spans. `-F`, `-t` and
 * editor messages pass unchecked.
 */
export function checkCommitAttribution(command: string): string | null {
  const commits = segments(shellTokens(stripHeredocBodies(command))).flatMap((segment) => {
    const args = commitArguments(segment);
    return args ? [{ segment, args }] : [];
  });
  if (commits.length === 0) return null;

  const bodies = heredocBodies(command)
    .filter((body) =>
      commits.some(({ segment }) => body.line >= segment.start && body.line <= segment.end),
    )
    .map((body) => body.text);
  const messages = [...commits.flatMap(({ args }) => messageValues(args)), ...bodies];
  return messages.some(creditsModel) ? REFUSAL : null;
}
