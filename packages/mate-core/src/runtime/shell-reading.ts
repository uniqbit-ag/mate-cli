/**
 * The one shell reader every guard check reads commands through, so they read
 * a command the same way. Pure: no filesystem, Git or environment. A
 * heuristic, not a parser: it finds the commands, words and redirects a
 * command spells out; it expands nothing, and does not read into `bash -c`,
 * `eval` or a script fed to a shell.
 */
import path from "node:path";

import { heredocMarker, splitHeredocs } from "./shell-heredoc";
import {
  ansiCQuote,
  backtickEnd,
  checkNesting,
  commentEnd,
  escapedInDoubleQuotes,
  parenEnd,
  singleQuoteEnd,
  startsAnsiCQuote,
} from "./shell-quoting";

export { MAX_SHELL_NESTING, ShellNestingError } from "./shell-quoting";

export interface ShellWord {
  /** Quotes removed, escapes applied, `$'…'` decoded; a substitution kept as written. */
  text: string;
  /** Holds a substitution, whose value only running it would tell. */
  opaque: boolean;
  /** The literal runs between its substitutions; `[text]` when not opaque. */
  pieces: string[];
  /** What its substitutions run. */
  commands: ShellCommand[];
}

export interface ShellRedirect {
  operator: string;
  target: ShellWord;
  /** `>&` onto a descriptor number or `-`: no file. */
  descriptor: boolean;
  /** How many `argv` words stand before it. */
  argvIndex: number;
}

export interface ShellCommand {
  /**
   * The name and arguments, after keywords, assignments and wrappers (their
   * option arguments skipped, `env -S` spliced in place). When the name's
   * position holds a substitution, that word comes first and nothing after it
   * is read as a wrapper.
   */
  argv: ShellWord[];
  redirects: ShellRedirect[];
  /**
   * Heredoc bodies it reads, each once: its own, those of earlier commands in
   * its pipeline, and those that reach a group it runs in (`{ }`, `( )`,
   * `if`, a loop, `case`), piped in or on the group's closer. Worked out when
   * read; {@link heredocBodies} reads many commands' in one pass.
   */
  readonly heredocs: string[];
}

export interface ShellReading {
  /** Every simple command, those of substitutions included: source order, then depth-first. */
  commands: ShellCommand[];
  /** Every word outside comments, at every level. */
  words: ShellWord[];
  /** Words in comments, read as command text. */
  comments: ShellWord[];
  /** The text with heredoc bodies and terminator lines removed, split at newlines. */
  lines: string[];
}

/**
 * Reads `text` once. Throws `ShellNestingError` when substitutions nest more
 * than `MAX_SHELL_NESTING` levels deep.
 */
export function readShell(text: string): ShellReading {
  const { kept, bodies } = splitHeredocs(text);
  const sink: Sink = { words: [], comments: [] };
  const top = readLevel(kept.join("\n"), 0, Bodies.of(bodies), sink, false);
  return { commands: flatten(top), words: sink.words, comments: sink.comments, lines: kept };
}

/**
 * Where heredoc bodies reach a command from: bodies of its own and other
 * feeds. Commands link to feeds instead of copying their bodies, so a long
 * pipeline or deep group costs memory in proportion to its length.
 */
interface Feed {
  bodies: string[];
  from: Feed[];
}

function feedFrom(...from: (Feed | null | undefined)[]): Feed {
  return { bodies: [], from: from.filter((feed): feed is Feed => feed != null) };
}

/** What each command reads. */
const commandInputs = new WeakMap<ShellCommand, Feed>();

/**
 * The heredoc bodies any of `commands` reads, each once: earlier pipeline
 * stages' before a command's own. One pass, however many commands share a
 * source.
 */
export function heredocBodies(commands: readonly ShellCommand[]): string[] {
  const bodies = new Set<string>();
  const visited = new Set<Feed>();
  const stack: { feed: Feed; expanded: boolean }[] = [];
  for (let i = commands.length - 1; i >= 0; i--) {
    const input = commandInputs.get(commands[i]);
    if (input) stack.push({ feed: input, expanded: false });
  }
  for (let top = stack.pop(); top; top = stack.pop()) {
    if (top.expanded) {
      for (const body of top.feed.bodies) bodies.add(body);
    } else if (!visited.has(top.feed)) {
      visited.add(top.feed);
      stack.push({ feed: top.feed, expanded: true });
      for (let i = top.feed.from.length - 1; i >= 0; i--) {
        stack.push({ feed: top.feed.from[i], expanded: false });
      }
    }
  }
  return [...bodies];
}

/** `<>` opens read-write; `>&` writes unless its operand is a descriptor. */
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", ">&", "<>"]);
/** Their operand is consumed, so it is never an argument. */
const READ_REDIRECTS = new Set(["<", "<<<", "<&"]);

/**
 * Every file the command names for writing: redirect targets and literal
 * `tee` operands, through wrappers and into substitutions. A word holding a
 * substitution is never a target.
 */
export function writeTargets(reading: ShellReading): string[] {
  return reading.commands.flatMap(commandWriteTargets);
}

function commandWriteTargets(command: ShellCommand): string[] {
  const targets: string[] = [];
  let next = 0;
  const redirectsUpTo = (argvIndex: number) => {
    for (; next < command.redirects.length; next++) {
      const redirect = command.redirects[next];
      if (redirect.argvIndex > argvIndex) return;
      if (
        WRITE_REDIRECTS.has(redirect.operator) &&
        !redirect.descriptor &&
        !redirect.target.opaque
      ) {
        targets.push(redirect.target.text);
      }
    }
  };
  const [name, ...operands] = command.argv;
  if (name && !name.opaque && path.basename(name.text) === "tee") {
    let optionsEnded = false;
    for (const [index, operand] of operands.entries()) {
      redirectsUpTo(index + 1);
      if (operand.opaque) continue;
      if (!optionsEnded && operand.text === "--") optionsEnded = true;
      else if (optionsEnded || !operand.text.startsWith("-")) targets.push(operand.text);
    }
  }
  redirectsUpTo(Number.POSITIVE_INFINITY);
  return targets;
}

/** One level of a command: the text itself, or a substitution's command. */
interface Level {
  commands: ShellCommand[];
  /** Substitutions in the order they were read. */
  nested: Level[];
}

function flatten(level: Level): ShellCommand[] {
  return [...level.commands, ...level.nested.flatMap(flatten)];
}

/** Appends one by one: spreading a long list into one call overflows Node's stack. */
function append<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}

interface Sink {
  words: ShellWord[];
  comments: ShellWord[];
}

type Token =
  /** `plain`: no quote, escape or substitution, so it may be a reserved word. */
  | { kind: "word"; word: ShellWord; plain: boolean }
  /** `heredoc`: the body a `<<` opens, when the reader settled it. */
  | { kind: "operator"; text: string; heredoc?: string };

/** Heredoc bodies keyed by the index of their `<<`, kept in index order. */
class Bodies {
  static readonly none = new Bodies([], []);

  private constructor(
    private readonly offsets: number[],
    private readonly texts: string[],
  ) {}

  static of(bodies: readonly { offset: number; text: string }[]): Bodies {
    const sorted = bodies.toSorted((a, b) => a.offset - b.offset);
    return new Bodies(
      sorted.map((body) => body.offset),
      sorted.map((body) => body.text),
    );
  }

  get size(): number {
    return this.offsets.length;
  }

  at(offset: number): string | undefined {
    const index = this.firstFrom(offset);
    return this.offsets[index] === offset ? this.texts[index] : undefined;
  }

  /** Those whose `<<` lies in [start, end), re-keyed by `toInner`, which keeps their order. */
  within(start: number, end: number, toInner: (offset: number) => number): Bodies {
    const offsets: number[] = [];
    const texts: string[] = [];
    for (let i = this.firstFrom(start); i < this.offsets.length && this.offsets[i] < end; i++) {
      offsets.push(toInner(this.offsets[i]));
      texts.push(this.texts[i]);
    }
    return new Bodies(offsets, texts);
  }

  /** The index of the first offset at or after `offset`. */
  private firstFrom(offset: number): number {
    let low = 0;
    let high = this.offsets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.offsets[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

/** `inComment`: a comment's text, whose words count as comments and whose `#` is plain. */
function readLevel(
  text: string,
  level: number,
  bodies: Bodies,
  sink: Sink,
  inComment: boolean,
): Level {
  checkNesting(level);
  const nested: Level[] = [];
  const reader: LevelReader = { level, sink, inComment, nested };
  const tokens = tokenize(text, bodies, reader);
  return { commands: commandsOf(tokens, reader), nested };
}

interface LevelReader {
  level: number;
  sink: Sink;
  inComment: boolean;
  nested: Level[];
}

const SHELL_SPACE = /[ \t\r]/;
/** A word that `(` turns into an array assignment: `name=(…)`, `name+=(…)`. */
const ARRAY_NAME = /^[A-Za-z_]\w*\+?=$/;

/**
 * Quote-aware words and operators, unquoted as Bash would. A substitution
 * makes its word opaque and is read one level down. `bodies` are keyed by the
 * index of their `<<` in `text`.
 */
function tokenize(text: string, bodies: Bodies, reader: LevelReader): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let run = "";
  let pieces: string[] = [];
  let commands: ShellCommand[] = [];
  let inWord = false;
  let quoted = false;
  /** A backslash escaped a character: the word is quoted for reserved words, not for descriptors. */
  let backslashed = false;
  let opaque = false;
  const add = (literal: string) => {
    word += literal;
    run += literal;
  };
  const flush = () => {
    if (inWord) {
      if (run) pieces.push(run);
      const shellWord: ShellWord = {
        text: word,
        opaque,
        pieces: opaque ? pieces : [word],
        commands,
      };
      (reader.inComment ? reader.sink.comments : reader.sink.words).push(shellWord);
      tokens.push({ kind: "word", word: shellWord, plain: !quoted && !backslashed && !opaque });
    }
    word = run = "";
    pieces = [];
    commands = [];
    inWord = quoted = backslashed = opaque = false;
  };
  const operator = (operatorText: string, heredoc?: string) => {
    flush();
    tokens.push({
      kind: "operator",
      text: operatorText,
      ...(heredoc === undefined ? {} : { heredoc }),
    });
  };
  const substitution = (start: number, end: number, inner: Level) => {
    reader.nested.push(inner);
    append(commands, flatten(inner));
    if (run) pieces.push(run);
    run = "";
    word += text.slice(start, end + 1);
    inWord = opaque = true;
    return end;
  };
  const readSubstitution = (inner: string, innerBodies: Bodies) => {
    const settled = withBodies(inner, innerBodies);
    return readLevel(settled.text, reader.level + 1, settled.bodies, reader.sink, reader.inComment);
  };
  const parenSubstitution = (start: number) => {
    const end = parenEnd(text, start + 1, reader.level + 1);
    const innerStart = start + 2;
    return substitution(
      start,
      end,
      readSubstitution(
        text.slice(innerStart, end),
        bodies.within(innerStart, end, (index) => index - innerStart),
      ),
    );
  };
  const backtickSubstitution = (start: number) => {
    const end = backtickEnd(text, start);
    const inner = unescapeBacktick(text.slice(start + 1, end));
    return substitution(
      start,
      end,
      readSubstitution(
        inner.text,
        bodies.within(start + 1, end, (index) => inner.indexOf(index - start - 1)),
      ),
    );
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === "#" && !inWord && !reader.inComment) {
      // Stop before the newline: it still ends the command.
      const end = commentEnd(text, i);
      readLevel(commentText(text, i, end), reader.level, Bodies.none, reader.sink, true);
      i = end - 1;
    } else if (startsAnsiCQuote(text, i)) {
      const ansi = ansiCQuote(text, i);
      add(ansi.value);
      inWord = quoted = true;
      i = ansi.end;
    } else if (char === "'") {
      const stop = singleQuoteEnd(text, i);
      add(text.slice(i + 1, stop));
      inWord = quoted = true;
      i = stop;
    } else if (char === '"') {
      inWord = quoted = true;
      for (i++; i < text.length && text[i] !== '"'; i++) {
        const inner = text[i];
        const escaped = text[i + 1];
        // A line continuation, or a backslash ending the text: Bash drops it.
        if (inner === "\\" && (escaped ?? "\n") === "\n") i++;
        else if (inner === "\\" && escapedInDoubleQuotes(escaped)) add(text[++i]);
        else if (inner === "$" && escaped === "(") i = parenSubstitution(i);
        else if (inner === "`") i = backtickSubstitution(i);
        else add(inner);
      }
    } else if (char === "$" && next === '"') {
      // `$"…"`: a translatable string; the `$` is no part of the word.
    } else if ((char === "$" || char === "<" || char === ">") && next === "(") {
      i = parenSubstitution(i);
    } else if (char === "`") {
      i = backtickSubstitution(i);
    } else if (char === "\\" && next !== undefined) {
      if (next !== "\n") {
        add(next);
        inWord = backslashed = true;
      }
      i++;
    } else if (SHELL_SPACE.test(char)) {
      flush();
    } else if (char === ">" || (char === "<" && next !== "<")) {
      // `2>`, `0<`: a bare number right before the operator names a descriptor, not a word.
      if (inWord && !quoted && /^\d+$/.test(word)) {
        word = run = "";
        inWord = false;
      }
      // `<&`, `<>`; `>>`, `>|`, `>&`.
      const suffixes = char === "<" ? "&>" : ">|&";
      const suffix = next !== undefined && suffixes.includes(next) ? next : "";
      i += suffix.length;
      operator(char + suffix);
    } else if (char === "&" && next === ">") {
      const appends = text[i + 2] === ">";
      i += appends ? 2 : 1;
      operator(appends ? "&>>" : "&>");
    } else if ((char === "&" || char === "|") && next === char) {
      i++;
      operator(char + char);
    } else if (char === "|" && next === "&") {
      // `|&` pipes standard error too.
      i++;
      operator("|&");
    } else if (char === "<" && next === "<") {
      if (text[i + 2] === "<") {
        i += 2;
        operator("<<<");
      } else {
        // The marker word is no file; one the reader cannot settle is read as a word.
        const body = bodies.at(i);
        const marker = heredocMarker(text, i);
        i = marker.delimiter === null ? i + 1 : marker.end - 1;
        operator("<<", body);
      }
    } else if (char === "\n") {
      operator(";");
    } else if (char === ";" && (next === ";" || next === "&")) {
      // A case arm's end: `;;`, `;;&`, `;&`.
      const end = next === ";" && text[i + 2] === "&" ? ";;&" : char + next;
      i += end.length - 1;
      operator(end);
    } else if (
      char === "(" &&
      inWord &&
      !quoted &&
      !backslashed &&
      !opaque &&
      ARRAY_NAME.test(word)
    ) {
      // `name=(…)`: an array's values, after which the command position goes on.
      operator("=(");
    } else if ("<;|&()".includes(char)) {
      operator(char);
    } else {
      add(char);
      inWord = true;
    }
  }
  flush();
  return tokens;
}

/**
 * A comment as the words in it are read: the `#` included, as a plain
 * character, and without a backslash that would continue the line outside a
 * comment, so `#\=.env` and `# x.pem\` still name their files.
 */
function commentText(text: string, start: number, end: number): string {
  const comment = text.slice(start, end);
  const trailing = /\\*$/.exec(comment)?.[0].length ?? 0;
  return trailing % 2 === 1 && text[end] === "\n" ? comment.slice(0, -1) : comment;
}

/**
 * A substitution's text and bodies: those the outer reading settled there or,
 * when it settled none, those the substitution read on its own settles. So a
 * body the outer reading could not place, behind a quote it misjudged or in a
 * backtick command before decoding, is still no command text.
 */
function withBodies(text: string, bodies: Bodies): { text: string; bodies: Bodies } {
  if (bodies.size > 0 || !text.includes("<<")) return { text, bodies };
  const split = splitHeredocs(text);
  if (split.bodies.length === 0) return { text, bodies };
  return { text: split.kept.join("\n"), bodies: Bodies.of(split.bodies) };
}

/**
 * A backtick substitution's command as Bash runs it: inside backticks, `\\`,
 * `` \` `` and `\$` lose one escape layer before the command is read, so an
 * escaped backtick there opens a nested substitution. `indexOf` maps an index
 * in the written text to the command's.
 */
function unescapeBacktick(written: string): { text: string; indexOf: (index: number) => number } {
  let text = "";
  const indexes: number[] = [];
  for (let i = 0; i < written.length; i++) {
    indexes[i] = text.length;
    if (written[i] === "\\" && i + 1 < written.length && "\\`$".includes(written[i + 1])) {
      indexes[++i] = text.length;
    }
    text += written[i];
  }
  return { text, indexOf: (index) => indexes[index] ?? text.length };
}

/** Reserved words after which the next word is still in command position. */
const COMMAND_KEYWORDS = new Set(["!", "{", "if", "then", "else", "elif", "while", "until", "do"]);

/**
 * A command that runs the command after its options. An unlisted option is
 * assumed to take no argument, so the next word is read as the command.
 */
interface CommandWrapper {
  /** Short option letters that take an argument. */
  short: string;
  /** Long option names, without `--`, that take a required argument. */
  long: readonly string[];
  /** The option whose argument is itself a command line: `env -S`/`--split-string`. */
  split?: { short: string; long: string };
}

/** GNU long spellings; optional-argument options (`xargs --replace[=R]`) take a value only after `=`, so are unlisted. */
const COMMAND_WRAPPERS: ReadonlyMap<string, CommandWrapper> = new Map([
  [
    "sudo",
    {
      short: "ugCDhprtTU",
      long: [
        "user",
        "group",
        "close-from",
        "chdir",
        "host",
        "prompt",
        "role",
        "type",
        "command-timeout",
        "other-user",
      ],
    },
  ],
  [
    "env",
    {
      short: "uCSP",
      long: ["unset", "chdir", "split-string"],
      split: { short: "S", long: "split-string" },
    },
  ],
  ["command", { short: "", long: [] }],
  ["exec", { short: "a", long: [] }],
  ["nohup", { short: "", long: [] }],
  ["nice", { short: "n", long: ["adjustment"] }],
  ["time", { short: "fo", long: ["format", "output"] }],
  ["stdbuf", { short: "ioe", long: ["input", "output", "error"] }],
  [
    "xargs",
    {
      short: "InLPsdaE",
      long: ["max-args", "max-procs", "max-chars", "delimiter", "arg-file", "process-slot-var"],
    },
  ],
]);
const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/;

/**
 * What a wrapper's option word asks of the words after it: `end` for `--`,
 * `next` when the next word is its argument (`split`: a command line), and
 * `split` with the command line the word itself holds.
 */
type WrapperOptionEffect =
  | { kind: "none" }
  | { kind: "end" }
  | { kind: "next"; split: boolean }
  | { kind: "split"; commandLine: string };

function wrapperOption(word: string, wrapper: CommandWrapper): WrapperOptionEffect {
  if (word === "--") return { kind: "end" };
  if (word.startsWith("--")) {
    const equals = word.indexOf("=");
    const name = word.slice(2, equals === -1 ? undefined : equals);
    if (!wrapper.long.includes(name)) return { kind: "none" };
    const split = name === wrapper.split?.long;
    if (equals === -1) return { kind: "next", split };
    return split ? { kind: "split", commandLine: word.slice(equals + 1) } : { kind: "none" };
  }
  for (let j = 1; j < word.length; j++) {
    if (!wrapper.short.includes(word[j])) continue;
    const split = word[j] === wrapper.split?.short;
    const rest = word.slice(j + 1);
    if (!rest) return { kind: "next", split };
    return split ? { kind: "split", commandLine: rest } : { kind: "none" };
  }
  return { kind: "none" };
}

/** Operators that keep the commands on either side in one pipeline; heredocs flow across them. */
const PIPELINE_OPERATORS = new Set(["|", "|&", "(", ")"]);
/** Operators that end a case arm; the next word is a pattern. */
const CASE_ARM_ENDS = new Set([";;", ";&", ";;&"]);

/** Reserved words that open a group in command position. A subshell's `(` opens one too. */
const GROUP_OPENERS = new Set(["{", "if", "while", "until", "for", "select", "case"]);
/** The reserved words that close a group, with the openers each closes. */
const GROUP_CLOSERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["}", ["{"]],
  ["fi", ["if"]],
  ["done", ["while", "until", "for", "select"]],
  ["esac", ["case"]],
]);
/** `time` is a reserved word as well as a wrapper: a group may follow it. */
const TIME = COMMAND_WRAPPERS.get("time");

/**
 * A compound command being read. Its commands share its standard input and
 * output, so heredoc bodies reach them past `;` and `&&`, and leave it through
 * a pipe after its closer.
 */
interface Group {
  opener: string;
  /** What is piped into it, which every command in it reads. */
  stdin: Feed | null;
  /** What its commands pass on, and its input: `{ cat; }` passes that on too. */
  output: Feed;
  /** Bodies on its closer, and its enclosing groups' `fed`: every command in it reads them. */
  fed: Feed;
  /** Where a `case` is: before `in`, at a pattern, or in an arm. */
  casePart?: "header" | "pattern" | "arm";
}

/** What a `(` opened: a subshell, an array's values, or neither (`f()`). */
type Paren = "subshell" | "array" | "other";

/** Groups tokens into simple commands, finding each command's name past keywords and wrappers. */
function commandsOf(tokens: Token[], reader: LevelReader): ShellCommand[] {
  const commands: ShellCommand[] = [];
  let current: ShellCommand | null = null;
  /** What `current` reads, and what it passes on to a pipe; set inside `command`, hence the casts. */
  let input = null as Feed | null;
  let output = null as Feed | null;
  /** What the next command reads from its pipeline or its group. */
  let piped: Feed | null = null;
  let named = false;
  let atCommand = true;
  let wrapper: CommandWrapper | null = null;
  /** What the next word is to the current wrapper's last option. */
  let pending: "argument" | "command line" | null = null;
  const parens: Paren[] = [];
  const groups: Group[] = [];
  /** Open groups per opener, so a closer with nothing to close costs nothing. */
  const open = new Map<string, number>();
  /** The group whose closer the current command is, until the next separator. */
  // Set inside `closeGroup`; the cast keeps TypeScript from narrowing it to null for good.
  let closed = null as Group | null;
  /** Token lists still to read, the innermost last: an `env -S` command line goes on top. */
  const sources = [{ tokens, next: 0 }];
  const live = () => {
    let top = sources.at(-1);
    while (top && top.next >= top.tokens.length) {
      sources.pop();
      top = sources.at(-1);
    }
    return top;
  };
  const peek = (): Token | undefined => {
    const top = live();
    return top?.tokens[top.next];
  };
  const take = (): Token | undefined => {
    const top = live();
    return top ? top.tokens[top.next++] : undefined;
  };
  const spliceCommandLine = (commandLine: string) =>
    sources.push({ tokens: tokenize(commandLine, Bodies.none, reader), next: 0 });

  const command = (): ShellCommand => {
    if (!current) {
      const reads = feedFrom(piped, groups.at(-1)?.fed);
      const created: ShellCommand = {
        argv: [],
        redirects: [],
        get heredocs() {
          return heredocBodies([created]);
        },
      };
      commandInputs.set(created, reads);
      current = created;
      input = reads;
      output = closed ? feedFrom(reads, closed.output) : reads;
    }
    return current;
  };
  const name = (word: ShellWord) => {
    command().argv.push(word);
    named = true;
    atCommand = false;
    wrapper = null;
  };
  const endCommand = (operator: string) => {
    const passed = output ?? (closed ? feedFrom(piped, closed.output) : null);
    if (current) commands.push(current);
    const group = groups.at(-1);
    if (group && passed) group.output.from.push(passed);
    piped = PIPELINE_OPERATORS.has(operator) ? (passed ?? piped) : (group?.stdin ?? null);
    current = input = output = closed = null;
    named = false;
    pending = null;
    wrapper = null;
  };
  const openGroup = (opener: string) => {
    groups.push({
      opener,
      stdin: piped,
      output: feedFrom(piped),
      fed: feedFrom(groups.at(-1)?.fed),
      ...(opener === "case" ? { casePart: "header" as const } : {}),
    });
    open.set(opener, (open.get(opener) ?? 0) + 1);
  };
  /** Closes the innermost group one of `openers` opened, and any left open inside it. */
  const closeGroup = (openers: readonly string[]) => {
    if (!openers.some((opener) => (open.get(opener) ?? 0) > 0)) return;
    let group = groups.pop();
    while (group) {
      open.set(group.opener, (open.get(group.opener) ?? 1) - 1);
      if (openers.includes(group.opener)) break;
      const outer = groups.pop();
      outer?.output.from.push(group.output);
      group = outer;
    }
    if (!group) return;
    piped = group.stdin;
    closed = group;
  };

  for (let token = take(); token; token = take()) {
    if (token.kind === "operator") {
      const group = groups.at(-1);
      if (WRITE_REDIRECTS.has(token.text) || READ_REDIRECTS.has(token.text)) {
        // A redirect may stand anywhere in a command; it leaves the command position as it was.
        const operand = peek();
        if (operand?.kind !== "word") continue;
        take();
        const target = operand.word;
        const ofCommand = command();
        ofCommand.redirects.push({
          operator: token.text,
          target,
          descriptor: token.text === ">&" && /^(\d+|-)$/.test(target.text),
          argvIndex: ofCommand.argv.length,
        });
      } else if (token.text === "<<") {
        if (token.heredoc !== undefined) {
          command();
          input?.bodies.push(token.heredoc);
          // On a closer it feeds the group: `while read l; do …; done <<EOF`.
          closed?.fed.bodies.push(token.heredoc);
        }
      } else if (group?.casePart === "pattern" && "(|)".includes(token.text)) {
        // A pattern's own `(`, `|` and `)`; its `)` opens the arm.
        if (token.text === ")") group.casePart = "arm";
      } else {
        endCommand(token.text);
        if (group?.casePart === "arm" && CASE_ARM_ENDS.has(token.text)) group.casePart = "pattern";
        if (token.text === "(" || token.text === "=(") {
          const paren: Paren = token.text === "=(" ? "array" : atCommand ? "subshell" : "other";
          if (paren === "subshell") openGroup("(");
          parens.push(paren);
          atCommand = true;
        } else if (token.text === ")") {
          const paren = parens.pop() ?? "other";
          if (paren === "subshell") closeGroup(["("]);
          atCommand = paren !== "subshell";
        } else {
          atCommand = true;
        }
      }
      continue;
    }
    const { word, plain } = token;
    const group = groups.at(-1);
    if (named) {
      if (plain && word.text === "in" && group?.casePart === "header") {
        // `case WORD in`: patterns follow.
        endCommand(";");
        group.casePart = "pattern";
        atCommand = true;
      } else {
        command().argv.push(word);
      }
      continue;
    }
    if (!atCommand) continue;
    if (group?.casePart === "pattern") {
      // A pattern names no command; only `esac` ends the case here.
      if (plain && word.text === "esac") {
        closeGroup(["case"]);
        name(word);
      }
      continue;
    }
    if (pending) {
      const was = pending;
      pending = null;
      if (was === "command line") {
        // An opaque command line could run anything; nothing after it is read as a command.
        if (word.opaque) name(word);
        else spliceCommandLine(word.text);
      }
      continue;
    }
    if (word.opaque) {
      name(word);
      continue;
    }
    if (wrapper && word.text.startsWith("-")) {
      const effect = wrapperOption(word.text, wrapper);
      if (effect.kind === "end") wrapper = null;
      else if (effect.kind === "next") pending = effect.split ? "command line" : "argument";
      else if (effect.kind === "split") spliceCommandLine(effect.commandLine);
      continue;
    }
    if (ASSIGNMENT.test(word.text)) continue;
    const reserved = plain && (!wrapper || wrapper === TIME);
    if (reserved && GROUP_OPENERS.has(word.text)) openGroup(word.text);
    const closes = reserved ? GROUP_CLOSERS.get(word.text) : undefined;
    if (closes) closeGroup(closes);
    if (COMMAND_KEYWORDS.has(word.text)) continue;
    const wrapperNamed = COMMAND_WRAPPERS.get(path.basename(word.text));
    if (wrapperNamed) {
      wrapper = wrapperNamed;
      continue;
    }
    name(word);
  }
  if (current) commands.push(current);
  return commands;
}
