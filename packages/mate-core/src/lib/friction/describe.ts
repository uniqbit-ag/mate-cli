import { FRAMEWORK_NAME } from "../../framework";
import type { FrictionCheck, ToolKind } from "../../runtime/friction-recorder";

const CHECKS: Record<FrictionCheck, string> = {
  secret: "The secret check",
  attribution: "The attribution check",
  artifact: "The artifact check",
  fork: "The fork check",
};

const TOOL_KINDS: Record<ToolKind, string> = {
  read: "a file read",
  write: "a file write",
  shell: "a shell command",
  search: "a search",
  other: "a tool call",
};

/** One plain sentence for a fingerprint; one it does not know is returned unchanged. */
export function describeFingerprint(fingerprint: string): string {
  const parts = fingerprint.split(":");
  const [form, check, kind] = parts;
  if (
    form === "refusal" &&
    parts.length === 3 &&
    Object.hasOwn(CHECKS, check) &&
    Object.hasOwn(TOOL_KINDS, kind)
  )
    return `${CHECKS[check as FrictionCheck]} refused ${TOOL_KINDS[kind as ToolKind]}`;
  if (form === "command" && parts.length >= 3) {
    const exitCode = parts.at(-1)!;
    if (/^\d+$/.test(exitCode)) {
      const command = [FRAMEWORK_NAME, parts.slice(1, -1).join(":")].join(" ").trim();
      return `${command} failed with exit code ${exitCode}`;
    }
  }
  return fingerprint;
}
