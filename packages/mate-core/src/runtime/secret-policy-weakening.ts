import fs from "node:fs";

import { parse } from "yaml";

import { foldCase, physicalPath } from "./physical-path";
import { companionFrameworkConfigPath } from "./policy";
import { parseSecretsConfig, type SecretPolicy } from "./secret-patterns";

export interface SecretEdit {
  oldText: string;
  newText: string;
  all: boolean;
}

/** How a write's result is computed; absent means `content` is the whole new file. */
export type SecretWriteResult = { kind: "replace"; edits: SecretEdit[] } | { kind: "unknown" };

export interface SecretPolicyWrite {
  path: string;
  content: string;
  result?: SecretWriteResult;
}

/** One line per way `next` enforces less than `current`; empty when equal or stricter. */
export function secretPolicyWeakenings(current: SecretPolicy, next: SecretPolicy): string[] {
  if (!current.guardrails) return [];
  const weakenings: string[] = [];
  if (!next.guardrails) weakenings.push("guardrails turned off");
  const currentAllow = new Set(current.allow);
  for (const pattern of new Set(next.allow)) {
    if (!currentAllow.has(pattern)) weakenings.push(`allow pattern added: ${pattern}`);
  }
  const nextDeny = new Set(next.deny);
  for (const pattern of new Set(current.deny)) {
    if (!nextDeny.has(pattern)) weakenings.push(`deny pattern removed: ${pattern}`);
  }
  return weakenings;
}

/**
 * The secret policy a `framework.yaml` text declares, as the guard reads it;
 * null when the YAML does not parse.
 */
export function secretPolicyOfConfigText(text: string): SecretPolicy | null {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    return null;
  }
  const config = parsed && typeof parsed === "object" ? (parsed as { secrets?: unknown }) : {};
  return parseSecretsConfig(config.secrets);
}

/** Whether `target` is, through links and letter case, the policy file the guard reads. */
export function isSecretPolicyFile(target: string, companionPath: string): boolean {
  if (!target || !companionPath) return false;
  return (
    foldCase(physicalPath(target)) ===
    foldCase(physicalPath(companionFrameworkConfigPath(companionPath)))
  );
}

/** Each edit must match once, or at least once when `all`; anything else cannot be replayed. */
function replay(text: string, edits: SecretEdit[]) {
  let result = text;
  for (const edit of edits) {
    if (!edit.oldText) return null;
    const first = result.indexOf(edit.oldText);
    if (first === -1) return null;
    if (edit.all) {
      result = result.split(edit.oldText).join(edit.newText);
    } else {
      if (result.indexOf(edit.oldText, first + 1) !== -1) return null;
      result = result.slice(0, first) + edit.newText + result.slice(first + edit.oldText.length);
    }
  }
  return result;
}

/** The file's text after the write, or null when it cannot be computed. */
function resultingText(write: SecretPolicyWrite): string | null {
  if (!write.result) return write.content;
  if (write.result.kind === "unknown") return null;
  let current: string;
  try {
    current = fs.readFileSync(write.path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    current = "";
  }
  return replay(current, write.result.edits);
}

function refusal(target: string, changes: string[]): string {
  return [
    "Mate guardrail: only the user can loosen the secret policy.",
    ` target: ${target}`,
    ...changes.map((change) => ` change: ${change}`),
    "Ask the user to make this change in the companion's framework.yaml themselves; do not work around this block.",
  ].join("\n");
}

/**
 * Refuses a write to the companion's policy file whose result weakens `current`
 * or cannot be computed. Callers run it only while guardrails are on.
 */
export function policyFileWriteRefusal(
  writes: readonly SecretPolicyWrite[],
  companionPath: string,
  current: SecretPolicy,
): string | null {
  for (const write of writes) {
    if (!isSecretPolicyFile(write.path, companionPath)) continue;
    const text = resultingText(write);
    const next = text === null ? null : secretPolicyOfConfigText(text);
    if (!next) return refusal(write.path, ["the result could not be checked"]);
    const weakenings = secretPolicyWeakenings(current, next);
    if (weakenings.length > 0) return refusal(write.path, weakenings);
  }
  return null;
}
