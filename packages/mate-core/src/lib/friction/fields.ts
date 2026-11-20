import { parseFingerprint } from "../../runtime/friction-fingerprint";
import type { FrictionEvent } from "../../runtime/friction-log";
import type { SecretFinding } from "../../runtime/secret-scan";

export const TEXT_LIMIT = 1_000;

export const cut = (text: string) => text.slice(0, TEXT_LIMIT);

/** The subject type a report on the event takes: `hook` for a refusal, `command` otherwise. */
export function eventSubjectType(event: Pick<FrictionEvent, "fingerprint">): "hook" | "command" {
  return parseFingerprint(event.fingerprint).form === "refusal" ? "hook" : "command";
}

/** `hook:<check>` for a refusal, `command:<command words>` for a failed command. */
export function eventSubject(event: Pick<FrictionEvent, "fingerprint">): string {
  return `${eventSubjectType(event)}:${parseFingerprint(event.fingerprint).name}`;
}

/** A refusal is an answer to the caller, not a failure: it carries a stable code. */
export class FrictionRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type SecretScan = (filePath: string, content: string) => Promise<SecretFinding[]>;

/** The scanner needs a file name; friction text is scanned as a companion write would be. */
const SCAN_NAME = "friction-report.md";

/**
 * Refuses text the secret scanner flags, naming its rules and never the text. The scanner
 * loads only here, so a caller without text never pays for it.
 */
export async function refuseSecrets(
  what: string,
  fields: (string | null)[],
  scan?: SecretScan,
): Promise<void> {
  let findings: SecretFinding[];
  try {
    const scanContent = scan ?? (await import("../../runtime/secret-scan")).scanContent;
    findings = await scanContent(SCAN_NAME, fields.filter((field) => field !== null).join("\n"));
  } catch {
    throw new FrictionRefusal(
      "scan-failed",
      `${what} could not be scanned for secrets; nothing was recorded.`,
    );
  }
  if (findings.length > 0) {
    const rules = [...new Set(findings.map((finding) => finding.ruleId))];
    throw new FrictionRefusal(
      "secret",
      `${what} holds a secret (${rules.join(", ")}); nothing was recorded. Replace the value with a placeholder or the variable name.`,
    );
  }
}
