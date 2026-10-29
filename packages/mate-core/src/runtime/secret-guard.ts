import fs from "node:fs";

import { resolveSecretPolicy } from "./policy";
import {
  BRACE_LIMIT,
  exceedsBraceLimit,
  globTargetsSecretFiles,
  isSecretFile,
} from "./secret-patterns";
import { describeSecretFindings, scanContent, type SecretFinding } from "./secret-scan";
import { readShell, type ShellReading } from "./shell-reading";

/**
 * A path as the Tool Guard resolved it. `path` is normalised against the
 * Working Repository and names the file in a refusal; `landing` is where the
 * path as written leads through links, and `exists` whether anything, a
 * dangling link included, sits there.
 */
export interface SecretTarget {
  path: string;
  landing: string;
  exists: boolean;
}

export interface SecretWrite extends SecretTarget {
  /** What the call would put into the file: a whole body or an edit's new text. */
  content: string;
  /** Whether the write lands in the Companion Repository, whose writes are content-scanned. */
  companion: boolean;
  /**
   * A move's source, absolute as written, which OpenCode writes whole to the
   * destination; `content` then holds the patch's added lines.
   */
  movedFrom?: string;
}

/** A tool call with its paths resolved; built by the Tool Guard, its only caller. */
export type SecretCheckCall =
  | { kind: "read"; targets: SecretTarget[] }
  | { kind: "write"; writes: SecretWrite[] }
  | { kind: "shell"; command: string }
  /** A content search: refused when it names a secret file or a glob aimed at secret files. */
  | { kind: "search"; targets: SecretTarget[]; globs: string[] };

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

function braceLimitRefusal(glob: string): string {
  return [
    `Mate guardrail: this search glob expands to more than ${BRACE_LIMIT} {a,b} alternatives, too many to check for secret files.`,
    ` glob: ${glob}`,
    "Split the search into globs with fewer alternatives.",
  ].join("\n");
}

/**
 * The words a shell command names, as the secret check judges them. Errs
 * toward refusing: the command is read per line (so a misjudged quote cannot
 * hide the next line) and whole (for quotes spanning lines); comments count
 * as text; a word holding a substitution counts as written and by each of its
 * literal parts (`x.pem$(true)` names `x.pem`). A quoted string stays one
 * word, so a commit message that mentions `.env` is not a reference to the
 * file. Nesting past `MAX_SHELL_NESTING` throws `ShellNestingError`.
 */
function shellWords(command: string): string[] {
  const reading = readShell(command);
  const perLine = reading.lines.flatMap((line) => judgedWords(readShell(line)));
  const seen = new Set(perLine);
  return [...perLine, ...judgedWords(reading).filter((word) => !seen.has(word))];
}

function judgedWords(reading: ShellReading): string[] {
  return [...reading.words, ...reading.comments]
    .flatMap((word) => (word.opaque ? [word.text, ...word.pieces] : [word.text]))
    .filter(Boolean);
}

/**
 * A word, plus the value of a `--flag=path` or `NAME=path` word; a word's
 * literal part after a substitution may start at the `=` (`--flag$(x)=path`).
 */
function candidatePaths(word: string): string[] {
  const equals = word.indexOf("=");
  return equals === -1 ? [word] : [word, word.slice(equals + 1)];
}

/**
 * Returns the refusal message for a call that touches a secret, or null. Reads
 * the companion's `secrets` block live, so a toggle applies to the next call.
 * First refusal wins: a secret file named, then a companion write's content,
 * then a path that lands on a secret file through a link.
 */
export async function checkSecretAccess(
  call: SecretCheckCall,
  companionPath: string,
  deps: SecretGuardDeps = {},
): Promise<string | null> {
  const policy = resolveSecretPolicy(companionPath);
  if (!policy.guardrails) return null;

  if (call.kind === "shell") {
    const named = shellWords(call.command)
      .flatMap(candidatePaths)
      .find((word) => isSecretFile(word, policy));
    return named ? secretFileRefusal(named) : null;
  }

  const targets = call.kind === "write" ? call.writes : call.targets;
  const named = targets.find((target) => target.path && isSecretFile(target.path, policy))?.path;
  if (named) return secretFileRefusal(named);

  if (call.kind === "search") {
    const glob = call.globs.find((candidate) => globTargetsSecretFiles(candidate, policy));
    if (glob) return exceedsBraceLimit(glob) ? braceLimitRefusal(glob) : secretFileRefusal(glob);
  }

  if (call.kind === "write") {
    const scanned = await scanCompanionWrites(call.writes, deps.scan ?? scanContent);
    if (scanned) return scanned;
  }

  // Looked up as written: normalising `link/..` first would inspect another file than the kernel opens.
  const landing = targets.find(
    (target) => target.path && target.exists && isSecretFile(target.landing, policy),
  );
  return landing ? secretFileRefusal(landing.path, landing.landing) : null;
}

async function scanCompanionWrites(
  writes: SecretWrite[],
  scan: NonNullable<SecretGuardDeps["scan"]>,
): Promise<string | null> {
  for (const write of writes) {
    const moved = write.movedFrom !== undefined;
    if (!write.path || (!write.content && !moved) || !write.companion) continue;
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
  write: SecretWrite,
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
