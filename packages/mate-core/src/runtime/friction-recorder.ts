import { resolveCompanionRuntime } from "./env";
import { FRAMEWORK_NAME } from "./framework";
import {
  commandFingerprint,
  refusalFingerprint,
  type FrictionCheck,
  type ToolKind,
} from "./friction-fingerprint";
import {
  appendEvent,
  firstInSession,
  type FrictionEvent,
  type FrictionRuntime,
} from "./friction-log";
import { readFrictionSwitch } from "./friction-switch";
import { mateVersion } from "./install";
import { maskSecretValues } from "./secret-values";

const MESSAGE_LIMIT = 1_000;
const PATH_LIMIT = 5;

type Env = Record<string, string | undefined>;

function nudgeFor(event: FrictionEvent | null, env: Env): string | null {
  if (!event || !firstInSession(event, { homeDir: env.HOME })) return null;
  return `Wrong or unclear? Run: ${FRAMEWORK_NAME} friction report ${event.id} --kind <bug|unclear> --expected "<what you expected>". Then continue with your task.`;
}

export function recordingFor(companionPath: string | undefined | null, env: Env): boolean {
  return Boolean(companionPath) && readFrictionSwitch(env.HOME);
}

interface RefusalEvidence {
  check: FrictionCheck;
  toolKind: ToolKind;
  message: string;
  /** The paths the call names; never its content. */
  paths?: string[];
}

/** No shell command: it can carry content. A secret refusal keeps only check and tool kind: its message and paths name the secret. */
export function refusalDetail(evidence: RefusalEvidence): Record<string, unknown> {
  const { check, toolKind: kind } = evidence;
  if (check === "secret") return { check, toolKind: kind };
  return {
    check,
    toolKind: kind,
    message: evidence.message.trim().slice(0, MESSAGE_LIMIT),
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

/** Records the refusal and returns the nudge to append to it, or null when none is due. */
export function recordRefusal(refusal: RefusalRecord): string | null {
  try {
    if (!recordingFor(refusal.companionPath, refusal.env)) return null;
    const recorded = appendEvent(
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
        }),
      },
      { homeDir: refusal.env.HOME },
    );
    return nudgeFor(recorded, refusal.env);
  } catch {
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

const FLAG_NAME = /^(?:-[A-Za-z]|--[a-z][a-z0-9-]*)$/;

/** Command, subcommand and flag names only: a flag's value or a positional is never kept. */
export function commandDetail(failure: CommandFailure): CommandDetail {
  const { command, subcommand } = commandWords(failure.args);
  const end = failure.args.indexOf("--");
  const flags = (end === -1 ? failure.args : failure.args.slice(0, end))
    .map((arg) => arg.split("=")[0])
    .filter((arg) => FLAG_NAME.test(arg));
  return {
    command,
    subcommand,
    flags: [...new Set(flags)],
    exitCode: failure.exitCode,
    errorText: withoutArgumentValues(failure.errorText, failure.args).trim().slice(-MESSAGE_LIMIT),
  };
}

const COMMAND_WORD = /^[a-z][a-z0-9-]*$/;
const RUNTIME_LAUNCHES = new Set(["claude", "opencode"]);
const CAP_WITHOUT_COMMAND = new Set(["graphify", "index", "sync"]);
const REDACTED_VALUE_MIN = 3;

function commandWords(args: string[]): { command: string | null; subcommand: string | null } {
  const positional = (index: number) => {
    const value = args[index];
    return value && COMMAND_WORD.test(value) ? value : null;
  };
  const command = positional(0);
  const subcommand = command && !RUNTIME_LAUNCHES.has(command) ? positional(1) : null;
  const capCommand =
    command === "cap" && subcommand && !CAP_WITHOUT_COMMAND.has(subcommand) ? positional(2) : null;
  return { command, subcommand: capCommand ? `${subcommand} ${capCommand}` : subcommand };
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function wholeValue(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = WORD_CHAR.test(value.at(0) ?? "") ? "(?<![\\p{L}\\p{N}])" : "";
  const after = WORD_CHAR.test(value.at(-1) ?? "") ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${before}${escaped}${after}`, "gu");
}

function withoutArgumentValues(text: string, args: string[]): string {
  const { command, subcommand } = commandWords(args);
  const kept = new Set([command, ...(subcommand?.split(" ") ?? [])]);
  const values = args
    .map((arg) => {
      const [name, ...value] = arg.split("=");
      return FLAG_NAME.test(name) ? value.join("=") : arg;
    })
    .filter((value) => value.length >= REDACTED_VALUE_MIN && !kept.has(value))
    .toSorted((a, b) => b.length - a.length);
  return values.reduce((result, value) => result.replace(wholeValue(value), "…"), text);
}

/** What a failed command printed, without its argument values and secret-named variables' values. */
export function redactCommandOutput(text: string, args: string[], env: Env): string {
  return maskSecretValues(withoutArgumentValues(text, args), env);
}

export interface CommandFailureRecord extends CommandFailure {
  session: { id: string; runtime: FrictionRuntime };
  mateVersion: string;
  env: Env;
  cwd: string;
}

/** Records the failure and returns the nudge to print after it, or null when none is due. */
export function recordCommandFailure(failure: CommandFailureRecord): string | null {
  try {
    const { companionPath, repositoryPath } = resolveCompanionRuntime(
      failure.env,
      failure.cwd,
    ).context;
    if (!recordingFor(companionPath, failure.env)) return null;
    const detail = commandDetail(failure);
    const recorded = appendEvent(
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
      { homeDir: failure.env.HOME },
    );
    const nudgeWouldLoop = detail.command === "friction";
    return nudgeWouldLoop ? null : nudgeFor(recorded, failure.env);
  } catch {
    return null;
  }
}
