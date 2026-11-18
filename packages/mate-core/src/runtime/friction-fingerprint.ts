import type { SecretToolCall } from "./secret-guard";

/**
 * The fingerprint of a Friction Event: `refusal:<check>:<tool kind>` or
 * `command:<command words>:<exit code>`. Stored in the log, so the format never changes.
 */

export type FrictionCheck = "secret" | "attribution" | "artifact" | "fork";
/** The adapters' secret-guard classification; "other" for a tool it does not classify. */
export type ToolKind = SecretToolCall["kind"] | "other";

export function refusalFingerprint(check: FrictionCheck, kind: ToolKind): string {
  return `refusal:${check}:${kind}`;
}

export function commandFingerprint(failure: {
  command: string | null;
  subcommand: string | null;
  exitCode: number;
}): string {
  const name = [failure.command ?? "", failure.subcommand]
    .filter((part) => part !== null)
    .join(" ");
  return `command:${name}:${failure.exitCode}`;
}

export interface FingerprintParts {
  /** `refusal` or `command` for a fingerprint Mate built. */
  form: string;
  /** The check of a refusal or the command words of a failed command; absent without a colon. */
  name: string | undefined;
  /** What follows the name: the tool kind of a refusal, the exit code of a failed command. */
  rest: string[];
}

/** Splits any text; the caller decides whether the parts make a known fingerprint. */
export function parseFingerprint(fingerprint: string): FingerprintParts {
  const [form, name, ...rest] = fingerprint.split(":");
  return { form, name, rest };
}
