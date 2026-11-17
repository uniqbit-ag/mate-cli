import { resolveCompanionRuntime } from "./env";
import { FRAMEWORK_NAME } from "./framework";
import {
  appendEvent,
  firstInSession,
  type FrictionRuntime,
  type NewFrictionEvent,
} from "./friction-log";
import { readFrictionSwitch } from "./friction-switch";
import { mateVersion } from "./install";
import type { SecretToolCall } from "./secret-guard";
import { maskSecretValues } from "./secret-values";

/**
 * Turns Mate's own refusals and failed agent-run commands into Friction Events.
 * Called only on the failure path, so an allowed call or a successful command
 * never reads the Friction Switch or the log. Never throws.
 */

export type FrictionCheck = "secret" | "attribution" | "artifact" | "fork";
/** The adapters' secret-guard classification; "other" for a tool it does not classify. */
export type ToolKind = SecretToolCall["kind"] | "other";

const MESSAGE_LIMIT = 1_000;
const COMMAND_LIMIT = 500;
const PATH_LIMIT = 5;

type Env = Record<string, string | undefined>;

/** A recorded event; `firstInSession` decides whether the agent is asked about it. */
export interface RecordedFriction {
  id: string;
  firstInSession: boolean;
}

function record(event: NewFrictionEvent, env: Env): RecordedFriction | null {
  const recorded = appendEvent(event, { homeDir: env.HOME });
  if (!recorded) return null;
  return { id: recorded.id, firstInSession: firstInSession(recorded, { homeDir: env.HOME }) };
}

/** One line, appended after a refusal or a failed command's own output. */
export function nudgeLine(id: string): string {
  return `Wrong or unclear? Run: ${FRAMEWORK_NAME} friction report ${id} --kind <bug|unclear> --expected "<what you expected>". Then continue with your task.`;
}

/** An event without a companion would be unreachable: the list and triage filter by companion. */
export function recordingFor(companionPath: string | undefined | null, env: Env): boolean {
  return Boolean(companionPath) && readFrictionSwitch(env.HOME);
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

/** The whole shell word after `NAME=`, concatenated and escaped segments included; an unclosed quote runs to the end. */
const ASSIGNMENT =
  /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(?:"(?:\\[\s\S]|[^"\\])*"|'[^']*'|\\[\s\S]|[^\s"'\\]|["'][\s\S]*)*/g;
const ANY_HEREDOC_MARKER = /(?<!<)<<(?!<)-?\s*(['"]?)([\w.-]+)\1/g;

/**
 * Unlike the guards' `stripHeredocBodies`, a marker inside quotes also opens a
 * body, as in `-m "$(cat <<'EOF'`: dropping too much is safe for evidence.
 */
function withoutHeredocBodies(command: string): string {
  const kept: string[] = [];
  const pending: string[] = [];
  for (const line of command.split("\n")) {
    if (pending.length > 0) {
      if (line.trim() === pending[0]) pending.shift();
      continue;
    }
    kept.push(line);
    for (const marker of line.matchAll(ANY_HEREDOC_MARKER)) pending.push(marker[2]);
  }
  return kept.join("\n");
}

/** Without heredoc bodies (content) or the values of `NAME=value` assignments. */
function shellEvidence(command: string): string {
  return withoutHeredocBodies(command.replace(ASSIGNMENT, "$1$2=…"));
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

export function recordRefusal(refusal: RefusalRecord): RecordedFriction | null {
  try {
    if (!recordingFor(refusal.companionPath, refusal.env)) return null;
    return record(
      {
        kind: "refusal",
        fingerprint: refusalFingerprint(refusal.check, refusal.toolKind),
        mateVersion: refusal.env.MATE_VERSION || mateVersion(),
        runtime: refusal.runtime,
        sessionId: refusal.sessionId,
        companion: refusal.companionPath,
        repositoryPath: refusal.repositoryPath || null,
        detail: refusalDetail({
          ...refusal,
          message: maskSecretValues(refusal.message, refusal.env),
          command: refusal.command && maskSecretValues(refusal.command, refusal.env),
        }),
      },
      refusal.env,
    );
  } catch {
    // recording never changes the refusal
    return null;
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
  const { command, subcommand } = commandWords(failure.args);
  const end = failure.args.indexOf("--");
  const flags = (end === -1 ? failure.args : failure.args.slice(0, end))
    .filter((arg) => arg.length > 1 && arg.startsWith("-"))
    .map((arg) => arg.split("=")[0]);
  return {
    command,
    subcommand,
    flags: [...new Set(flags)],
    exitCode: failure.exitCode,
    errorText: withoutArgumentValues(failure.errorText, failure.args).trim().slice(-MESSAGE_LIMIT),
  };
}

const COMMAND_WORD = /^[a-z][a-z0-9-]*$/;
/** Their arguments go to the Agent Runtime (paths, prompts), so none is a subcommand. */
const RUNTIME_LAUNCHES = new Set(["claude", "opencode"]);
/** Shorter values are left alone: replacing them garbles the text and leaks little. */
const REDACTED_VALUE_MIN = 3;

function commandWords(args: string[]): { command: string | null; subcommand: string | null } {
  // A command word; a path or a prompt in that position is not kept.
  const positional = (index: number) => {
    const value = args[index];
    return value && COMMAND_WORD.test(value) ? value : null;
  };
  const command = positional(0);
  const subcommand = command && !RUNTIME_LAUNCHES.has(command) ? positional(1) : null;
  return { command, subcommand };
}

/** A command may echo its arguments: every flag value and positional except the command words is replaced. */
export function withoutArgumentValues(text: string, args: string[]): string {
  const { command, subcommand } = commandWords(args);
  const kept = new Set([command, subcommand]);
  const values = args
    .map((arg) => (arg.startsWith("-") ? arg.split("=").slice(1).join("=") : arg))
    .filter((value) => value.length >= REDACTED_VALUE_MIN && !kept.has(value))
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

export function recordCommandFailure(failure: CommandFailureRecord): RecordedFriction | null {
  try {
    const { companionPath, repositoryPath } = resolveCompanionRuntime(
      failure.env,
      failure.cwd,
    ).context;
    if (!recordingFor(companionPath, failure.env)) return null;
    const detail = commandDetail(failure);
    const recorded = record(
      {
        kind: "command-failure",
        fingerprint: commandFingerprint(detail),
        mateVersion: failure.mateVersion || "unknown",
        runtime: failure.session.runtime,
        sessionId: failure.session.id,
        companion: companionPath,
        repositoryPath: repositoryPath || null,
        detail: { ...detail },
      },
      failure.env,
    );
    // A failed friction command gets no nudge, so reporting cannot loop.
    const reporting = detail.command === "friction";
    return recorded && reporting ? { ...recorded, firstInSession: false } : recorded;
  } catch {
    // recording never changes the command's outcome
    return null;
  }
}
