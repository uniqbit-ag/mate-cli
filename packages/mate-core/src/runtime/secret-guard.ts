import fs from "node:fs";

import { resolveSecretPolicy } from "./policy";
import { globTargetsSecretFiles, isSecretFile } from "./secret-patterns";
import { describeSecretFindings, scanContent, type SecretFinding } from "./secret-scan";
import { heredocMarker, stripHeredocBodies } from "./shell-heredoc";
import {
  ansiCQuote,
  backtickCommand,
  backtickEnd,
  checkNesting,
  escapedInDoubleQuotes,
  parenEnd,
  startsAnsiCQuote,
} from "./shell-quoting";

export type WriteMode = "create" | "edit";

/** Runtime-neutral tool call; the Claude hook and OpenCode middleware both translate into it, so they refuse alike. */
export type GuardedToolCall =
  | { kind: "read"; paths: string[] }
  /** `content` is what the call would put into the file: a whole body or an edit's new text. */
  | { kind: "write"; writes: GuardedWrite[] }
  | { kind: "shell"; command: string }
  /** A content search: refused when it names a secret file or a glob aimed at secret files. */
  | { kind: "search"; paths: string[]; globs: string[] };

export interface GuardedWrite {
  path: string;
  content: string;
  mode: WriteMode;
  /**
   * A move's source, which OpenCode writes whole to `path`; `content` then holds
   * the patch's added lines. A companion destination is scanned as the source's
   * content plus those lines. The Tool Guard resolves it against the Working
   * Repository first.
   */
  movedFrom?: string;
}

export interface SecretGuardScope {
  companionPath: string;
  /** Whether a target lands in the Companion Repository, whose writes are content-scanned. */
  isCompanionPath: (filePath: string) => boolean;
}

export interface SecretGuardDeps {
  scan?: (filePath: string, content: string) => Promise<SecretFinding[]>;
}

const SWITCH_HINT =
  "Secret guardrails are on. The user can add an allow pattern or opt out under `secrets` in the companion's framework.yaml; do not work around this block.";

/** `landsIn`: where a link at `filePath` leads, when that, not the name, is the secret file. */
export function secretFileRefusal(filePath: string, landsIn?: string): string {
  return [
    "Mate guardrail: secret files are off-limits to agents.",
    ` target: ${filePath}`,
    ...(landsIn ? [` lands in: ${landsIn} (through a link)`] : []),
    "Refer to the variable by name, read an example file such as .env.example, or ask the user to set the value.",
    SWITCH_HINT,
  ].join("\n");
}

const SHELL_SEPARATOR = /[\s;|&<>()`]/;

/**
 * Shell words with quotes removed, redirect operators as separators and
 * heredoc bodies dropped. A heuristic, not a parser: it exists to find file
 * names a command spells out, and a quoted string stays one word, so a
 * commit message that mentions `.env` is not a reference to the file.
 *
 * Errs toward refusing: comments count as text, and the command is read per
 * line (so a misjudged quote cannot hide the next line) and whole (for quotes
 * spanning lines). Substitutions count too; nesting past `MAX_SHELL_NESTING`
 * throws `ShellNestingError`.
 */
export function shellWords(command: string): string[] {
  const text = stripHeredocBodies(command);
  const perLine = text.split("\n").flatMap((line) => readWords(line));
  const seen = new Set(perLine);
  return [...perLine, ...readWords(text).filter((word) => !seen.has(word))];
}

/**
 * One reading's words. Outside quotes a substitution's parentheses and
 * backticks separate words; inside double quotes the substitution stays in
 * its word and its command's words are read too, `level` deeper.
 */
function readWords(text: string, level = 0): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | undefined;
  let quoted = false;
  const flush = () => {
    if (word || quoted) words.push(word);
    word = "";
    quoted = false;
  };
  const substitution = (start: number, end: number, inner: string) => {
    words.push(...readWords(inner, level + 1));
    word += text.slice(start, end + 1);
    return end;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (quote === '"' && char === "$" && text[i + 1] === "(") {
        const end = parenEnd(text, i + 1, level + 1);
        i = substitution(i, end, text.slice(i + 2, end));
      } else if (quote === '"' && char === "`") {
        checkNesting(level + 1);
        const end = backtickEnd(text, i);
        i = substitution(i, end, backtickCommand(text.slice(i + 1, end)));
      } else if (char === "\\" && quote === '"' && (text[i + 1] ?? "\n") === "\n") {
        i++; // A line continuation: Bash drops the backslash and the newline.
      } else if (char === "\\" && quote === '"' && escapedInDoubleQuotes(text[i + 1])) {
        word += text[++i];
      } else word += char;
    } else if (startsAnsiCQuote(text, i)) {
      const ansi = ansiCQuote(text, i);
      word += ansi.value;
      quoted = true;
      i = ansi.end;
    } else if (char === "$" && text[i + 1] === '"') {
      // `$"…"` is a double-quoted string Bash may translate; the `$` is no part of the word.
    } else if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
    } else if (char === "\\" && text[i + 1] === "\n") {
      i++; // A line continuation joins the lines, inside a word too.
    } else if (char === "\\" && i + 1 < text.length) {
      word += text[++i];
    } else if (char === "<" && text[i + 1] === "<") {
      flush();
      if (text[i + 2] === "<") {
        i += 2;
      } else {
        // The marker word names no file; one the reader cannot settle is read as words.
        const marker = heredocMarker(text, i);
        i = marker.delimiter === null ? i + 1 : marker.end - 1;
      }
    } else if (SHELL_SEPARATOR.test(char)) {
      flush();
    } else {
      word += char;
    }
  }
  flush();
  return words.filter(Boolean);
}

/** A word, plus the value of a `--flag=path` or `NAME=path` word. */
function candidatePaths(word: string): string[] {
  const equals = word.indexOf("=");
  return equals > 0 ? [word, word.slice(equals + 1)] : [word];
}

/**
 * Returns the refusal message for a call that touches a secret, or null. Reads
 * the companion's `secrets` block live, so a toggle applies to the next call.
 */
export async function checkSecretAccess(
  call: GuardedToolCall,
  scope: SecretGuardScope,
  deps: SecretGuardDeps = {},
): Promise<string | null> {
  const policy = resolveSecretPolicy(scope.companionPath);
  if (!policy.guardrails) return null;

  if (call.kind === "shell") {
    const named = shellWords(call.command)
      .flatMap(candidatePaths)
      .find((word) => isSecretFile(word, policy));
    return named ? secretFileRefusal(named) : null;
  }

  if (call.kind === "search") {
    const named =
      call.paths.find((filePath) => filePath && isSecretFile(filePath, policy)) ??
      call.globs.find((glob) => globTargetsSecretFiles(glob, policy));
    return named ? secretFileRefusal(named) : null;
  }

  const paths = call.kind === "read" ? call.paths : call.writes.map((write) => write.path);
  const secretPath = paths.find((filePath) => filePath && isSecretFile(filePath, policy));
  if (secretPath) return secretFileRefusal(secretPath);
  if (call.kind === "read") return null;

  const scan = deps.scan ?? scanContent;
  for (const write of call.writes) {
    const moved = write.movedFrom !== undefined;
    if (!write.path || (!write.content && !moved) || !scope.isCompanionPath(write.path)) continue;
    let content = write.content;
    if (write.movedFrom !== undefined) {
      const movedIn = movedContent(write, write.movedFrom);
      if ("refusal" in movedIn) return movedIn.refusal;
      content = movedIn.content;
    }
    if (!content) continue;
    let findings: SecretFinding[];
    try {
      // oxlint-disable-next-line no-await-in-loop -- the first refusal wins
      findings = await scan(write.path, content);
    } catch {
      return [
        "Mate guardrail: content for the Companion Repository could not be scanned for secrets, so the write is blocked.",
        ` target: ${write.path}`,
        SWITCH_HINT,
      ].join("\n");
    }
    if (findings.length > 0) {
      return [
        "Mate guardrail: this write would put a secret into the Companion Repository.",
        ` target: ${write.path}`,
        ...describeSecretFindings(findings).map((line) => ` finding: ${line}`),
        moved
          ? "Replace the value with a placeholder or the variable name before moving the file. In a moved file, secretlint-disable comments do not apply."
          : "Replace the value with a placeholder or the variable name. For a deliberate fake, wrap it in secretlint-disable/secretlint-enable comments.",
        SWITCH_HINT,
      ].join("\n");
    }
  }
  return null;
}

/**
 * What a move puts into the companion: the source's whole content plus the
 * patch's added lines, secretlint directives made inert. A refusal when the
 * source cannot be read in full.
 */
function movedContent(
  write: GuardedWrite,
  movedFrom: string,
): { content: string } | { refusal: string } {
  const source = readMovedSource(movedFrom);
  if ("problem" in source) {
    return {
      refusal: [
        "Mate guardrail: a file moved into the Companion Repository could not be checked for secrets, so the move is blocked.",
        ` target: ${write.path}`,
        ` source: ${movedFrom}`,
        ` reason: ${source.problem}`,
        "Write the content you need into a new companion file instead, so it can be scanned.",
        SWITCH_HINT,
      ].join("\n"),
    };
  }
  return {
    content: neutraliseSecretlintDirectives(
      [source.content, write.content].filter(Boolean).join("\n"),
    ),
  };
}

/** How much of a moved file the guard reads; a larger one is not moved into the companion. */
const MOVED_SOURCE_LIMIT = 1024 * 1024;

/**
 * Never partial content, which could leave a secret unscanned. Non-blocking,
 * so a FIFO named as the source cannot stall the guard.
 */
function readMovedSource(filePath: string): { content: string } | { problem: string } {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return { problem: "it is not a regular file" };
    const buffer = Buffer.alloc(MOVED_SOURCE_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = fs.readSync(descriptor, buffer, size, buffer.length - size, size);
      if (read === 0) break;
      size += read;
    }
    if (size > MOVED_SOURCE_LIMIT) return { problem: "it is larger than 1 MiB" };
    return { content: buffer.subarray(0, size).toString("utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { problem: `it could not be read${code ? ` (${code})` : ""}` };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** secretlint honours its directives anywhere in the text, in any syntax, so every occurrence is renamed. */
function neutraliseSecretlintDirectives(content: string): string {
  return content.replace(/secretlint-(?=disable|enable)/gi, "secretlint_");
}
