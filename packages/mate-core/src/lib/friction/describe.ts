import { FRAMEWORK_NAME } from "../../framework";
import {
  parseFingerprint,
  type FrictionCheck,
  type ToolKind,
} from "../../runtime/friction-fingerprint";

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
  const { form, name, rest } = parseFingerprint(fingerprint);
  if (
    form === "refusal" &&
    name !== undefined &&
    rest.length === 1 &&
    Object.hasOwn(CHECKS, name) &&
    Object.hasOwn(TOOL_KINDS, rest[0])
  )
    return `${CHECKS[name as FrictionCheck]} refused ${TOOL_KINDS[rest[0] as ToolKind]}`;
  if (form === "command" && rest.length > 0) {
    const exitCode = rest.at(-1)!;
    if (/^\d+$/.test(exitCode)) {
      const words = [name, ...rest.slice(0, -1)].join(":");
      return `${[FRAMEWORK_NAME, words].join(" ").trim()} failed with exit code ${exitCode}`;
    }
  }
  return fingerprint;
}
