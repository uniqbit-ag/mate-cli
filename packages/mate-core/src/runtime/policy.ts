import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "./framework";
import {
  defaultSecretPolicy,
  parseSecretsConfig,
  secretRules,
  type SecretPolicy,
} from "./secret-patterns";

/**
 * Predicates that are never projected: they are read live from the companion
 * so toggling a Capability takes effect without a projection refresh.
 */
export interface CompanionPolicy {
  allowedAgents: string[];
  /** Names of the Capabilities the companion has enabled. */
  enabledCapabilities: string[];
  gitAutoMode: boolean;
  /**
   * Secret guardrails. Unlike the other fields, a missing or broken config
   * yields guardrails on: protection never fails open.
   */
  secrets: SecretPolicy;
}

export const emptyCompanionPolicy = (): CompanionPolicy => ({
  allowedAgents: [],
  enabledCapabilities: [],
  gitAutoMode: false,
  secrets: defaultSecretPolicy(),
});

export function companionFrameworkConfigPath(companionPath: string): string {
  return path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function capabilityNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined,
    )
    .filter((name): name is string => typeof name === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Falls back to legacy `profiles.default.allowedAgents`. Shared by the launch
 * loader and the policy reader so both agree on the policy document.
 */
export function declaredAllowedAgents(config: {
  allowedAgents?: unknown;
  profiles?: unknown;
}): unknown {
  if (config.allowedAgents !== undefined && config.allowedAgents !== null) {
    return config.allowedAgents;
  }
  const profiles = config.profiles;
  return isRecord(profiles) && isRecord(profiles.default)
    ? profiles.default.allowedAgents
    : undefined;
}

/**
 * Synchronous so it composes into `readCompanionRuntimeContext`. A missing or
 * unparseable companion config yields an inert policy rather than throwing,
 * with secret guardrails active.
 */
export function readCompanionPolicy(companionPath: string): CompanionPolicy {
  let parsed: unknown;
  try {
    parsed = parse(fs.readFileSync(companionFrameworkConfigPath(companionPath), "utf8"));
  } catch {
    return emptyCompanionPolicy();
  }
  if (!parsed || typeof parsed !== "object") return emptyCompanionPolicy();

  const config = parsed as Record<string, unknown>;
  return {
    allowedAgents: stringList(declaredAllowedAgents(config)),
    enabledCapabilities: capabilityNames(config.capabilities),
    gitAutoMode: config.git === "auto",
    secrets: parseSecretsConfig(config.secrets),
  };
}

/** The companion's live secret policy, read on every call. */
export function resolveSecretPolicy(companionPath: string): SecretPolicy {
  return readCompanionPolicy(companionPath).secrets;
}

/** The `MATE_POLICY_JSON` document; one builder so every session carries the same secret rules. */
export function policyDocument(input: { allowedAgents: string[]; secrets: SecretPolicy }): string {
  return JSON.stringify({
    allowedAgents: input.allowedAgents,
    secrets: secretRules(input.secrets),
  });
}

export function isCapabilityEnabled(policy: CompanionPolicy, name: string): boolean {
  return policy.enabledCapabilities.includes(name);
}
