import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "./framework";

/**
 * Predicates that are never projected: they are read live from the companion
 * so toggling a Capability takes effect without a projection refresh.
 */
export interface CompanionPolicy {
  allowedAgents: string[];
  /** Names of the Capabilities the companion has enabled. */
  enabledCapabilities: string[];
  gitAutoMode: boolean;
}

export const emptyCompanionPolicy = (): CompanionPolicy => ({
  allowedAgents: [],
  enabledCapabilities: [],
  gitAutoMode: false,
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

/**
 * A base-set key from `audiences.base`, the shape a companion is saved in. The
 * lenient twin of the setup normalizer, which `runtime/` cannot import.
 */
function baseAudienceKey(config: Record<string, unknown>, key: string): unknown {
  const audiences = config.audiences;
  if (!audiences || typeof audiences !== "object") return undefined;
  const base = (audiences as Record<string, unknown>).base;
  return base && typeof base === "object" ? (base as Record<string, unknown>)[key] : undefined;
}

/**
 * Synchronous so it composes into `readCompanionRuntimeContext`. A missing or
 * unparseable companion config yields an inert policy rather than throwing.
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
    allowedAgents: stringList(config.allowedAgents),
    enabledCapabilities: capabilityNames(
      config.capabilities ?? baseAudienceKey(config, "capabilities"),
    ),
    gitAutoMode: config.git === "auto",
  };
}

export function isCapabilityEnabled(policy: CompanionPolicy, name: string): boolean {
  return policy.enabledCapabilities.includes(name);
}
