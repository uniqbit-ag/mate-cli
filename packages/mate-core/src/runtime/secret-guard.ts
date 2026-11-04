import { resolveSecretPolicy } from "./policy";
import {
  BRACE_LIMIT,
  exceedsBraceLimit,
  globTargetsSecretFiles,
  isSecretFile,
} from "./secret-patterns";
import { describeSecretFindings, scanContent, type SecretFinding } from "./secret-scan";
import { HEREDOC_MARKER, stripHeredocBodies } from "./shell-heredoc";

/**
 * The secret check both runtimes run before a tool call: the Claude PreToolUse
 * hook and the OpenCode middleware translate their own tool payloads into one
 * of these shapes, so the two refuse the same calls for the same reasons.
 */
export type SecretToolCall =
  | { kind: "read"; paths: string[] }
  /** `content` is what the call would put into the file: a whole body or an edit's new text. */
  | { kind: "write"; writes: { path: string; content: string }[] }
  | { kind: "shell"; command: string }
  /** A content search: refused when it names a secret file or a glob aimed at secret files. */
  | { kind: "search"; paths: string[]; globs: string[] };

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

function secretFileRefusal(filePath: string): string {
  return [
    "Mate guardrail: secret files are off-limits to agents.",
    ` target: ${filePath}`,
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

const SHELL_SEPARATOR = /[\s;|&<>()`]/;

/**
 * Shell words with quotes removed, redirect operators as separators and
 * heredoc bodies dropped. A heuristic, not a parser: it exists to find file
 * names a command spells out, and a quoted string stays one word, so a
 * commit message that mentions `.env` is not a reference to the file.
 */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  for (const line of stripHeredocBodies(command).split("\n")) {
    let word = "";
    let quote: string | undefined;
    let quoted = false;
    const flush = () => {
      if (word || quoted) words.push(word);
      word = "";
      quoted = false;
    };
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quote) {
        if (char === quote) quote = undefined;
        else if (char === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
        else word += char;
      } else if (char === "'" || char === '"') {
        quote = char;
        quoted = true;
      } else if (char === "\\" && i + 1 < line.length) {
        word += line[++i];
      } else if (char === "<" && line[i + 1] === "<") {
        flush();
        const marker = HEREDOC_MARKER.exec(line.slice(i));
        i += marker ? marker[0].length - 1 : 1;
      } else if (SHELL_SEPARATOR.test(char)) {
        flush();
      } else {
        word += char;
      }
    }
    flush();
  }
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
  call: SecretToolCall,
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
    const named = call.paths.find((filePath) => filePath && isSecretFile(filePath, policy));
    if (named) return secretFileRefusal(named);
    const glob = call.globs.find((candidate) => globTargetsSecretFiles(candidate, policy));
    if (!glob) return null;
    return exceedsBraceLimit(glob) ? braceLimitRefusal(glob) : secretFileRefusal(glob);
  }

  const paths = call.kind === "read" ? call.paths : call.writes.map((write) => write.path);
  const secretPath = paths.find((filePath) => filePath && isSecretFile(filePath, policy));
  if (secretPath) return secretFileRefusal(secretPath);
  if (call.kind === "read") return null;

  const scan = deps.scan ?? scanContent;
  for (const write of call.writes) {
    if (!write.path || !write.content || !scope.isCompanionPath(write.path)) continue;
    let findings: SecretFinding[];
    try {
      // oxlint-disable-next-line no-await-in-loop -- the first refusal wins
      findings = await scan(write.path, write.content);
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
        "Replace the value with a placeholder or the variable name. For a deliberate fake, wrap it in secretlint-disable/secretlint-enable comments.",
        SWITCH_HINT,
      ].join("\n");
    }
  }
  return null;
}
