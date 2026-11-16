import { resolveCompanionRuntime } from "./env";
import { appendEvent, type FrictionRuntime } from "./friction-log";
import { stripHeredocBodies } from "./shell-heredoc";
import { isCapabilityEnabled, readCompanionPolicy } from "./policy";
import type { SecretToolCall } from "./secret-guard";

/**
 * Turns Mate's own refusals and failed agent-run commands into Friction Events.
 * Called only on the failure path, so an allowed call or a successful command
 * never reads a companion policy or the log. Never throws.
 */

export type FrictionCheck = "secret" | "attribution" | "artifact" | "fork";
/** The adapters' secret-guard classification; "other" for a tool it does not classify. */
export type ToolKind = SecretToolCall["kind"] | "other";

export const FRICTION_CAPABILITY = "friction";

const MESSAGE_LIMIT = 1_000;
const COMMAND_LIMIT = 500;
const PATH_LIMIT = 5;

type Env = Record<string, string | undefined>;

export function frictionSelected(companionPath: string | undefined | null): boolean {
  if (!companionPath) return false;
  try {
    return isCapabilityEnabled(readCompanionPolicy(companionPath), FRICTION_CAPABILITY);
  } catch {
    return false;
  }
}

interface RefusalEvidence {
  check: FrictionCheck;
  toolKind: ToolKind;
  message: string;
  /** The shell command of a shell call. */
  command?: string;
  /** The paths the call names; never its content. */
  paths?: string[];
}

function refusalFingerprint(check: FrictionCheck, kind: ToolKind): string {
  return `refusal:${check}:${kind}`;
}

const ASSIGNMENT = /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(?:"(?:\\.|[^"\\])*"|'[^']*'|\S*)/gs;

/** Without heredoc bodies (content) or the values of `NAME=value` assignments. */
function shellEvidence(command: string): string {
  return stripHeredocBodies(command.replace(ASSIGNMENT, "$1$2=…"));
}

/** A secret refusal keeps only check and tool kind: its message and paths name the secret. */
export function refusalDetail(evidence: RefusalEvidence): Record<string, unknown> {
  const { check, toolKind: kind } = evidence;
  if (check === "secret") return { check, toolKind: kind };
  return {
    check,
    toolKind: kind,
    message: evidence.message.trim().slice(0, MESSAGE_LIMIT),
    // A refused write's command can carry what it writes; its paths are kept instead.
    ...(check === "attribution" && kind === "shell" && evidence.command
      ? { command: shellEvidence(evidence.command).slice(0, COMMAND_LIMIT) }
      : {}),
    paths: (evidence.paths ?? []).filter(Boolean).slice(0, PATH_LIMIT),
  };
}

export interface RefusalRecord extends RefusalEvidence {
  companionPath: string;
  repositoryPath: string | null;
  runtime: FrictionRuntime;
  sessionId: string;
  env: Env;
}

export function recordRefusal(record: RefusalRecord): void {
  try {
    if (!frictionSelected(record.companionPath)) return;
    appendEvent(
      {
        kind: "refusal",
        fingerprint: refusalFingerprint(record.check, record.toolKind),
        mateVersion: record.env.MATE_VERSION || "unknown",
        runtime: record.runtime,
        sessionId: record.sessionId,
        companion: record.companionPath,
        repositoryPath: record.repositoryPath || null,
        detail: refusalDetail(record),
      },
      { homeDir: record.env.HOME },
    );
  } catch {
    // recording never changes the refusal
  }
}

export interface CommandFailure {
  /** Arguments after the executable and script. */
  args: string[];
  exitCode: number;
  /** The tail of what the command printed to stderr. */
  errorText: string;
}

interface CommandDetail {
  command: string | null;
  subcommand: string | null;
  flags: string[];
  exitCode: number;
  errorText: string;
}

/** Command, subcommand and flag names only: a flag's value or a positional is never kept. */
export function commandDetail(failure: CommandFailure): CommandDetail {
  // A command word; a path or a prompt in that position is not kept.
  const positional = (index: number) => {
    const value = failure.args[index];
    return value && COMMAND_WORD.test(value) ? value : null;
  };
  const command = positional(0);
  const subcommand = command && !RUNTIME_LAUNCHES.has(command) ? positional(1) : null;
  const end = failure.args.indexOf("--");
  const flags = (end === -1 ? failure.args : failure.args.slice(0, end))
    .filter((arg) => arg.length > 1 && arg.startsWith("-"))
    .map((arg) => arg.split("=")[0]);
  return {
    command,
    subcommand,
    flags: [...new Set(flags)],
    exitCode: failure.exitCode,
    errorText: withoutArgumentValues(failure.errorText, failure.args, [command, subcommand])
      .trim()
      .slice(-MESSAGE_LIMIT),
  };
}

const COMMAND_WORD = /^[a-z][a-z0-9-]*$/;
/** Their arguments go to the Agent Runtime (paths, prompts), so none is a subcommand. */
const RUNTIME_LAUNCHES = new Set(["claude", "opencode"]);
/** Shorter values are left alone: replacing them garbles the text and leaks little. */
const REDACTED_VALUE_MIN = 3;

/** A command may echo its arguments: every flag value and positional is replaced. */
function withoutArgumentValues(text: string, args: string[], kept: (string | null)[]): string {
  const values = args
    .map((arg) => (arg.startsWith("-") ? arg.split("=").slice(1).join("=") : arg))
    .filter((value) => value.length >= REDACTED_VALUE_MIN && !kept.includes(value))
    .toSorted((a, b) => b.length - a.length);
  return values.reduce((result, value) => result.replaceAll(value, "…"), text);
}

export function commandFingerprint({ command, subcommand, exitCode }: CommandDetail): string {
  const name = [command ?? "", subcommand].filter((part) => part !== null).join(" ");
  return `command:${name}:${exitCode}`;
}

export interface CommandFailureRecord extends CommandFailure {
  session: { id: string; runtime: FrictionRuntime };
  mateVersion: string;
  env: Env;
  cwd: string;
}

export function recordCommandFailure(record: CommandFailureRecord): void {
  try {
    const { companionPath, repositoryPath } = resolveCompanionRuntime(
      record.env,
      record.cwd,
    ).context;
    if (!frictionSelected(companionPath)) return;
    const detail = commandDetail(record);
    appendEvent(
      {
        kind: "command-failure",
        fingerprint: commandFingerprint(detail),
        mateVersion: record.mateVersion || "unknown",
        runtime: record.session.runtime,
        sessionId: record.session.id,
        companion: companionPath,
        repositoryPath: repositoryPath || null,
        detail: { ...detail },
      },
      { homeDir: record.env.HOME },
    );
  } catch {
    // recording never changes the command's outcome
  }
}
