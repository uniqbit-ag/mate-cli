/**
 * The Tool Guard: the one verdict every Agent Runtime reaches before a tool
 * call. Adapters only translate to {@link GuardedToolCall} and back; they hold
 * no verdict logic.
 *
 * First refusal wins, in order: secret access, commit attribution, artifact
 * path, forked companion. Unreadable calls and guard failures
 * ({@link guardFailureMessage}) are refused: the guard fails closed.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { artifactRefusal, resolveArtifactTarget } from "./artifact-refusal";
import { checkCommitAttribution } from "./commit-attribution-guard";
import { companionForkRefusal } from "./companion-sync";
import { resolveSecretPolicy } from "./policy";
import {
  absoluteAsWritten,
  foldCase,
  isWithin,
  PATH_SEPARATORS,
  physicalPath,
} from "./physical-path";
import { companionLinkPath } from "./repo-local";
import {
  checkSecretAccess,
  secretFileRefusal,
  type GuardedToolCall,
  type SecretGuardDeps,
  type WriteMode,
} from "./secret-guard";
import { isSecretFile, type SecretPolicy } from "./secret-patterns";
import { heredocMarker, stripHeredocBodies } from "./shell-heredoc";
import {
  ansiCQuote,
  backtickCommand,
  backtickEnd,
  checkNesting,
  commentEnd,
  escapedInDoubleQuotes,
  MAX_SHELL_NESTING,
  parenEnd,
  ShellNestingError,
  singleQuoteEnd,
  startsAnsiCQuote,
} from "./shell-quoting";

export type { GuardedToolCall, GuardedWrite, WriteMode } from "./secret-guard";

export interface ToolGuardScope {
  /** As resolved for the session; refusal messages name it. */
  companionPath: string;
  /**
   * Working Repository root; relative targets resolve against it. Empty for a
   * companion-scoped launch: no Git or product-documentation exemptions apply.
   */
  repositoryPath: string;
  /** Relative-target base without a Working Repository. Defaults to `process.cwd()`. */
  workingDirectory?: string;
  /** Folders holding the Agent Runtime's own state; writes there are never artifacts. */
  runtimeStateRoots: readonly string[];
  /** The session's environment; only the fork check's launch gate reads it. */
  env: Record<string, string | undefined>;
}

/**
 * `unreadable`: the call cannot be read well enough for any check to vouch
 * for it (a shell command nested deeper than {@link MAX_SHELL_NESTING}).
 */
export type ToolGuardCheck = "unreadable" | "secret" | "attribution" | "artifact" | "fork";

export interface ToolGuardRefusal {
  check: ToolGuardCheck;
  /** The check's message, without a trailing newline. */
  message: string;
}

export type ToolGuardDeps = SecretGuardDeps;

/** Lower-case: classification ignores letter case, see {@link artifactLikePath}. */
const KNOWN_ARTIFACT_BASENAMES = new Set([
  "claude.md",
  "context.md",
  "design.md",
  "explore-brief.md",
  "proposal.md",
  "spec.md",
  "tasks.md",
]);

const ARTIFACT_PATH_MARKERS = [
  "/changes/",
  "/openspec/",
  "/specs/",
  "/docs/adr/",
  "/docs/adrs/",
  "/docs/decisions/",
  "/docs/prd/",
];

/** Case-insensitive, like secret-file matching: macOS and Windows treat `notes.md` and `NOTES.MD` as one file. */
function artifactLikePath(filePath: string): boolean {
  if (!filePath) return false;

  const lower = filePath.toLowerCase();
  const basename = path.basename(lower);
  const normalized = "/" + lower.replaceAll("\\", "/").replace(/^\/+/, "");
  if (KNOWN_ARTIFACT_BASENAMES.has(basename)) return true;
  if (ARTIFACT_PATH_MARKERS.some((marker) => normalized.includes(marker))) return true;
  return basename.endsWith(".md") && basename !== "readme.md";
}

/** An `opaque` word holds a substitution, whose value only running it would tell: never a target. */
type ShellToken =
  | { kind: "word"; text: string; opaque: boolean }
  | { kind: "operator"; text: string };

/** `<>` opens read-write; `>&` writes unless its operand is a descriptor. */
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", ">&", "<>"]);
/** Their operand is consumed, so it is never a `tee` operand. */
const READ_REDIRECTS = new Set(["<", "<<<", "<&"]);
const SHELL_SPACE = /[ \t\r]/;

const SHELL_TOO_DEEP = [
  `Mate guardrail: this shell command nests substitutions more than ${MAX_SHELL_NESTING} levels deep, too deep to check, so it is blocked.`,
  "Split it into smaller commands.",
].join("\n");

interface NestedCommand {
  text: string;
  level: number;
}

/**
 * Quote-aware shell words and operators, unquoted as Bash would. A
 * substitution makes its word opaque and adds its command text to `nested`,
 * one level down. A heuristic, not a parser: it finds the files a command
 * names for writing, not what the shell would expand.
 */
function shellTokens(commandText: string, nested: NestedCommand[], level: number): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  let opaque = false;
  const flush = () => {
    if (inWord) tokens.push({ kind: "word", text: word, opaque });
    word = "";
    inWord = quoted = opaque = false;
  };
  const operator = (text: string) => {
    flush();
    tokens.push({ kind: "operator", text });
  };
  const substitution = (start: number, end: number, inner: string) => {
    nested.push({ text: inner, level: level + 1 });
    word += commandText.slice(start, end + 1);
    inWord = opaque = true;
    return end;
  };
  const parenSubstitution = (start: number) => {
    const end = parenEnd(commandText, start + 1, level + 1);
    return substitution(start, end, commandText.slice(start + 2, end));
  };
  const backtickSubstitution = (start: number) => {
    const end = backtickEnd(commandText, start);
    return substitution(start, end, backtickCommand(commandText.slice(start + 1, end)));
  };

  for (let i = 0; i < commandText.length; i++) {
    const char = commandText[i];
    const next = commandText[i + 1];
    if (char === "#" && !inWord) {
      // Stop before the newline: it still ends the command.
      i = commentEnd(commandText, i) - 1;
    } else if (startsAnsiCQuote(commandText, i)) {
      const ansi = ansiCQuote(commandText, i);
      word += ansi.value;
      inWord = quoted = true;
      i = ansi.end;
    } else if (char === "'") {
      const stop = singleQuoteEnd(commandText, i);
      word += commandText.slice(i + 1, stop);
      inWord = quoted = true;
      i = stop;
    } else if (char === '"') {
      inWord = quoted = true;
      for (i++; i < commandText.length && commandText[i] !== '"'; i++) {
        const inner = commandText[i];
        const escaped = commandText[i + 1];
        if (inner === "\\" && escaped === "\n") i++;
        else if (inner === "\\" && escapedInDoubleQuotes(escaped)) word += commandText[++i];
        else if (inner === "$" && escaped === "(") i = parenSubstitution(i);
        else if (inner === "`") i = backtickSubstitution(i);
        else word += inner;
      }
    } else if (char === "$" && next === '"') {
      // `$"…"`: a translatable string; the `$` is no part of the word.
    } else if ((char === "$" || char === "<" || char === ">") && next === "(") {
      i = parenSubstitution(i);
    } else if (char === "`") {
      i = backtickSubstitution(i);
    } else if (char === "\\" && next !== undefined) {
      if (next !== "\n") {
        word += next;
        inWord = true;
      }
      i++;
    } else if (SHELL_SPACE.test(char)) {
      flush();
    } else if (char === ">" || (char === "<" && next !== "<")) {
      // `2>`, `0<`: a bare number right before the operator names a descriptor, not a word.
      if (inWord && !quoted && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      // `<&`, `<>`; `>>`, `>|`, `>&`.
      const suffixes = char === "<" ? "&>" : ">|&";
      const suffix = next !== undefined && suffixes.includes(next) ? next : "";
      i += suffix.length;
      operator(char + suffix);
    } else if (char === "&" && next === ">") {
      const append = commandText[i + 2] === ">";
      i += append ? 2 : 1;
      operator(append ? "&>>" : "&>");
    } else if ((char === "&" || char === "|") && next === char) {
      i++;
      operator(char + char);
    } else if (char === "<" && next === "<") {
      if (commandText[i + 2] === "<") {
        i += 2;
        operator("<<<");
      } else {
        // The marker word is no file; one the reader cannot settle is read as a word.
        const marker = heredocMarker(commandText, i);
        i = marker.delimiter === null ? i + 1 : marker.end - 1;
        operator("<<");
      }
    } else if (char === "\n") {
      operator(";");
    } else if ("<;|&()".includes(char)) {
      operator(char);
    } else {
      word += char;
      inWord = true;
    }
  }
  flush();
  return tokens;
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

/**
 * Every file a shell command names for writing: redirect targets and literal
 * `tee` operands, through wrappers and into substitutions. Nothing is
 * expanded, so a word holding a variable, glob or substitution is never a
 * target. Throws {@link ShellNestingError} past {@link MAX_SHELL_NESTING}.
 */
function shellWriteTargets(command: string, level = 0): string[] {
  checkNesting(level);
  const nested: NestedCommand[] = [];
  const tokens = shellTokens(stripHeredocBodies(command), nested, level);
  const targets: string[] = [];
  let teeOperands = false;
  let optionsEnded = false;
  let atCommand = true;
  let wrapper: CommandWrapper | null = null;
  /** What the next word is to the current wrapper's last option. */
  let pending: "argument" | "command line" | null = null;
  /** Per open `(`, whether it opened a subshell; only a subshell's `)` ends a command. */
  const parens: boolean[] = [];
  const spliceCommandLine = (index: number, commandLine: string) =>
    tokens.splice(index + 1, 0, ...shellTokens(commandLine, nested, level));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "operator") {
      if (WRITE_REDIRECTS.has(token.text) || READ_REDIRECTS.has(token.text)) {
        // A redirect may stand anywhere in a command; it leaves the command position as it was.
        const operand = tokens[i + 1];
        if (operand?.kind !== "word") continue;
        i++;
        const descriptor = token.text === ">&" && /^(\d+|-)$/.test(operand.text);
        if (WRITE_REDIRECTS.has(token.text) && !descriptor && !operand.opaque) {
          targets.push(operand.text);
        }
      } else if (token.text !== "<<") {
        teeOperands = false;
        pending = null;
        wrapper = null;
        if (token.text === "(") parens.push(atCommand);
        atCommand = token.text === ")" ? !(parens.pop() ?? false) : true;
      }
      continue;
    }
    if (teeOperands) {
      if (token.opaque) continue;
      if (!optionsEnded && token.text === "--") optionsEnded = true;
      else if (optionsEnded || !token.text.startsWith("-")) targets.push(token.text);
      continue;
    }
    if (!atCommand) continue;
    if (pending) {
      const was = pending;
      pending = null;
      if (was === "command line") {
        // An opaque command line could run anything; nothing after it is read as a command.
        if (token.opaque) atCommand = false;
        else spliceCommandLine(i, token.text);
      }
      continue;
    }
    if (token.opaque) {
      atCommand = false;
      continue;
    }
    if (wrapper && token.text.startsWith("-")) {
      const effect = wrapperOption(token.text, wrapper);
      if (effect.kind === "end") wrapper = null;
      else if (effect.kind === "next") pending = effect.split ? "command line" : "argument";
      else if (effect.kind === "split") spliceCommandLine(i, effect.commandLine);
      continue;
    }
    if (ASSIGNMENT.test(token.text) || COMMAND_KEYWORDS.has(token.text)) continue;
    const name = path.basename(token.text);
    const named = COMMAND_WRAPPERS.get(name);
    if (named) {
      wrapper = named;
      continue;
    }
    atCommand = false;
    wrapper = null;
    if (name === "tee") {
      teeOperands = true;
      optionsEnded = false;
    }
  }
  return [...targets, ...nested.flatMap((inner) => shellWriteTargets(inner.text, inner.level))];
}

function shellArtifactTargets(command: string): string[] {
  return shellWriteTargets(command).filter((target) => target.toLowerCase().endsWith(".md"));
}

/** Per call; each part is computed on first use. */
interface GuardContext {
  scope: ToolGuardScope;
  /**
   * The companion as messages name it and as the fork check reads it: the
   * configured path normalised, unless a link before a `..` makes that
   * spelling reach another folder; then where the configured path lands.
   */
  companion: () => string;
  /** Followed through every link, so filesystem identity decides the verdict. */
  companionReal: () => string;
  /**
   * The Projection Root's companion link, its folder followed through every
   * link and its own name kept; empty without a Working Repository.
   */
  companionLink: () => string;
  repoRoot: string;
  base: string;
  /** The Working Repository followed through every link. */
  repoReal: () => string;
}

function once<T>(compute: () => T): () => T {
  let value: { result: T } | undefined;
  return () => (value ??= { result: compute() }).result;
}

function guardContext(scope: ToolGuardScope): GuardContext {
  const ctx: GuardContext = {
    scope,
    companion: once(() => {
      const normalised = path.normalize(scope.companionPath);
      return physicalPath(normalised) === ctx.companionReal() ? normalised : ctx.companionReal();
    }),
    // Configured paths, too, are followed as written, never normalised first.
    companionReal: once(() => physicalPath(scope.companionPath)),
    companionLink: once(() => {
      if (!scope.repositoryPath) return "";
      const link = companionLinkPath(ctx.repoReal());
      return path.join(physicalPath(path.dirname(link)), path.basename(link));
    }),
    repoRoot: scope.repositoryPath,
    base: scope.repositoryPath || scope.workingDirectory || process.cwd(),
    repoReal: once(() => physicalPath(scope.repositoryPath)),
  };
  return ctx;
}

/**
 * Where a write to `target`, as written and relative to `base`, lands; see
 * {@link physicalPath}. Adapters use it to tell whether two spellings name one file.
 */
export function landingPath(target: string, base: string): string {
  return physicalPath(absoluteAsWritten(target, base));
}

/** A tool input's content field: anything but a string carries no content. */
export function contentText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A tool input's path or command field: a malformed value is still judged, as `String()` spells it. */
export function pathText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export function singleWrite(filePath: unknown, content: string, mode: WriteMode): GuardedToolCall {
  return { kind: "write", writes: [{ path: pathText(filePath), content, mode }] };
}

interface ResolvedTarget {
  path: string;
  mode: WriteMode;
  /** Normalised against the Working Repository, as the refusal message shows it. */
  lexical: string;
  /** Where the write lands; every filesystem decision reads this one. */
  physical: string;
}

function resolveTarget(
  entry: { path: string; mode: WriteMode },
  ctx: GuardContext,
): ResolvedTarget {
  return {
    ...entry,
    lexical: resolveArtifactTarget(entry.path, ctx.base),
    physical: landingPath(entry.path, ctx.base),
  };
}

/**
 * Under the Projection Root's companion link, or under the companion it lands
 * in — the second answers for a link the operator made, and for the first once
 * its target exists. Never a match on path characters alone. `physical` is a
 * {@link physicalPath} result.
 */
function isCompanionPath(physical: string, ctx: GuardContext): boolean {
  const link = ctx.companionLink();
  return (link !== "" && isWithin(physical, link)) || isWithin(physical, ctx.companionReal());
}

/**
 * Every inherited `GIT_*` variable dropped, not only the repository-locating
 * ones `gitEnvironment` clears: `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` could
 * otherwise add an excludes file that makes a new note look ignored. These two
 * queries are local and read-only, so they need no SSH or credential variable.
 */
function guardGitEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
  );
}

function gitAnswers(ctx: GuardContext, physical: string, args: string[]): boolean {
  if (!ctx.repoRoot || !isWithin(physical, ctx.repoReal())) return false;
  const relPath = path.relative(ctx.repoReal(), physical);
  const result = spawnSync("git", ["-C", ctx.repoRoot, ...args, "--", relPath], {
    stdio: "ignore",
    env: guardGitEnvironment(),
  });
  return result.status === 0;
}

const isGitignored = (physical: string, ctx: GuardContext) =>
  gitAnswers(ctx, physical, ["check-ignore", "--no-index", "-q"]);

/**
 * A file the Working Repository tracks is product material, not a new agent
 * artifact. Literal, so a new `*.md` is not covered by a tracked `notes.md`
 * (`check-ignore` reads its path literally already).
 */
const isGitTracked = (physical: string, ctx: GuardContext) =>
  gitAnswers(ctx, physical, ["--literal-pathspecs", "ls-files", "--error-unmatch"]);

function isProductDocumentationPath(physical: string, ctx: GuardContext): boolean {
  if (!ctx.repoRoot) return false;
  const root = ctx.repoReal();
  if (!isWithin(physical, root)) return false;

  const parts = path.relative(root, physical).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (part === ".storybook" || part === "storybook") return true;
    if (part !== "docs") continue;
    const docsRoot = path.join(root, ...parts.slice(0, index + 1));
    if (fs.existsSync(path.join(docsRoot, "package.json"))) return true;
  }
  return false;
}

/**
 * Inside a state root where the write lands, or, written without `..`, as
 * written: a user's link in their runtime folder (e.g. into dotfiles) stays
 * state, unless it lands in the Working Repository.
 */
function isRuntimeState(target: ResolvedTarget, ctx: GuardContext): boolean {
  const asWritten =
    !target.path.split(PATH_SEPARATORS).includes("..") &&
    !(ctx.repoRoot && isWithin(target.physical, ctx.repoReal()));
  return ctx.scope.runtimeStateRoots.some(
    (root) =>
      isWithin(target.physical, physicalPath(root)) ||
      // A root configured with `..` has no as-written spelling to compare against.
      (asWritten &&
        !root.split(PATH_SEPARATORS).includes("..") &&
        isWrittenUnder(target.lexical, root)),
  );
}

/**
 * Whether `lexical` lies under `root` as written. A differently cased prefix
 * counts if it is the root's own folder (same device and inode); comparing
 * folders, not resolved paths, leaves links inside the root unfollowed.
 */
function isWrittenUnder(lexical: string, root: string): boolean {
  if (isWithin(lexical, root)) return true;
  const rootPath = path.resolve(root);
  const depth = rootPath.split(path.sep).length;
  const parts = path.resolve(lexical).split(path.sep);
  if (parts.length < depth) return false;
  const prefix = parts.slice(0, depth).join(path.sep);
  return foldCase(prefix) === foldCase(rootPath) && isSameFolder(prefix, rootPath);
}

function isSameFolder(a: string, b: string): boolean {
  try {
    const [first, second] = [fs.statSync(a), fs.statSync(b)];
    return first.isDirectory() && first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

function isExistingFile(physical: string): boolean {
  try {
    return fs.statSync(physical).isFile();
  } catch {
    return false;
  }
}

function artifactRefusalFor(target: ResolvedTarget, ctx: GuardContext): ToolGuardRefusal | null {
  if (!target.path) return null;

  const { physical } = target;
  if (isCompanionPath(physical, ctx)) return null;
  if (isRuntimeState(target, ctx)) return null;
  if (target.mode === "edit" && isExistingFile(physical)) return null;
  if (isProductDocumentationPath(physical, ctx)) return null;
  if (!artifactLikePath(target.path)) return null;
  if (isGitignored(physical, ctx) || isGitTracked(physical, ctx)) return null;

  // The normalised path, unless a link before a `..` makes it name another file.
  const shown = physicalPath(target.lexical) === physical ? target.lexical : physical;
  return {
    check: "artifact",
    message: artifactRefusal({
      target: target.path,
      resolved: shown,
      companion: ctx.companion(),
      repoRoot: ctx.repoRoot,
    }),
  };
}

/** Depends on companion Git state, not just tool input; `companionForkRefusal` gates on the launch environment. */
async function forkRefusalFor(
  target: ResolvedTarget,
  ctx: GuardContext,
): Promise<ToolGuardRefusal | null> {
  if (!target.path || !artifactLikePath(target.path)) return null;
  if (!isCompanionPath(target.physical, ctx)) return null;
  const message = await companionForkRefusal(ctx.scope.env, ctx.companion());
  return message ? { check: "fork", message } : null;
}

/**
 * The call with every path resolved against the Working Repository, as the
 * secret check reads it: normalised, except a moved file's source, which the
 * check reads from disk and so keeps as written.
 */
function resolvedForSecrets(call: GuardedToolCall, base: string): GuardedToolCall {
  const resolve = (value: string) => (value ? resolveArtifactTarget(value, base) : "");
  switch (call.kind) {
    case "read":
      return { kind: "read", paths: call.paths.map(resolve) };
    case "write":
      return {
        kind: "write",
        writes: call.writes.map((entry) => ({
          ...entry,
          path: resolve(entry.path),
          ...(entry.movedFrom === undefined
            ? {}
            : { movedFrom: absoluteAsWritten(entry.movedFrom, base) }),
        })),
      };
    case "search":
      return { kind: "search", paths: call.paths.map(resolve), globs: call.globs };
    case "shell":
      return call;
  }
}

/** Whether anything, a dangling link included, sits at `filePath`. */
function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A non-shell path that lands, through a link, on a secret file; the secret
 * check only judges names. Looked up as written: normalising `link/..` first
 * would inspect another file than the kernel opens.
 */
function secretLandingRefusal(call: GuardedToolCall, ctx: GuardContext): string | null {
  if (call.kind === "shell") return null;
  const named = call.kind === "write" ? call.writes.map((entry) => entry.path) : call.paths;
  let policy: SecretPolicy | undefined;
  for (const value of named) {
    if (!value) continue;
    const written = absoluteAsWritten(value, ctx.base);
    if (!pathExists(written)) continue;
    const lexical = resolveArtifactTarget(value, ctx.base);
    const landing = physicalPath(written);
    policy ??= resolveSecretPolicy(ctx.scope.companionPath);
    if (!policy.guardrails) return null;
    if (isSecretFile(landing, policy)) return secretFileRefusal(lexical, landing);
  }
  return null;
}

function writtenTargets(call: GuardedToolCall): { path: string; mode: WriteMode }[] {
  if (call.kind === "write") return call.writes;
  if (call.kind === "shell") {
    return shellArtifactTargets(call.command).map((target) => ({ path: target, mode: "create" }));
  }
  return [];
}

/**
 * The first refusal for `call`, or null when every check allows it. Paths in
 * `call` are as the agent wrote them; relative ones resolve against the
 * Working Repository, never a preceding `cd`.
 */
export async function checkToolCall(
  call: GuardedToolCall,
  scope: ToolGuardScope,
  deps: ToolGuardDeps = {},
): Promise<ToolGuardRefusal | null> {
  if (!scope.companionPath) return null;
  const ctx = guardContext(scope);

  let targets: ResolvedTarget[];
  let secret: string | null;
  try {
    targets = writtenTargets(call).map((entry) => resolveTarget(entry, ctx));
    // A companion write by landing or by normalised path; over-scanning is harmless.
    secret = await checkSecretAccess(
      resolvedForSecrets(call, ctx.base),
      {
        companionPath: scope.companionPath,
        isCompanionPath: (lexical) =>
          targets.some(
            (target) => target.lexical === lexical && isCompanionPath(target.physical, ctx),
          ) || isCompanionPath(physicalPath(lexical), ctx),
      },
      deps,
    );
  } catch (error) {
    if (error instanceof ShellNestingError) return { check: "unreadable", message: SHELL_TOO_DEEP };
    throw error;
  }
  if (secret) return { check: "secret", message: secret };
  const landing = secretLandingRefusal(call, ctx);
  if (landing) return { check: "secret", message: landing };

  if (call.kind === "shell") {
    const attribution = checkCommitAttribution(call.command);
    if (attribution) return { check: "attribution", message: attribution };
  }

  for (const target of targets) {
    const refusal = artifactRefusalFor(target, ctx);
    if (refusal) return refusal;
  }
  for (const target of targets) {
    // oxlint-disable-next-line no-await-in-loop -- the first refusal wins
    const refusal = await forkRefusalFor(target, ctx);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * The refusal an adapter gives when the guard itself throws: the call is
 * refused, never allowed unchecked. One line, so it reads as one reason.
 */
export function guardFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Mate guardrail could not check this call: ${detail.replaceAll(/\s*\n\s*/g, " ")}`;
}
