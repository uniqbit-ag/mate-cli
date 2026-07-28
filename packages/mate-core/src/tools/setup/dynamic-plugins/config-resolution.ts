import fs from "node:fs/promises";

import { parse } from "yaml";

import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import { pluginLocalOverridesPath } from "./paths";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges a local override over a committed plugin config: objects merge
 * recursively, arrays and scalars from the override replace the committed
 * value. Either side may be absent.
 */
export function deepMergePluginConfig(committed: unknown, override: unknown): unknown {
  if (override === undefined) return committed;
  if (!isRecord(committed) || !isRecord(override)) return override;
  const merged: Record<string, unknown> = { ...committed };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = deepMergePluginConfig(committed[key], value);
  }
  return merged;
}

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface InterpolationResult {
  value: unknown;
  /** Referenced-but-unset variable names, in first-seen order. */
  missing: string[];
}

/**
 * Replaces `${VAR}` occurrences in every string value with the corresponding
 * environment value, recursively through objects and arrays. Unset variables
 * are collected instead of substituted.
 */
export function interpolateEnvVars(
  value: unknown,
  env: Record<string, string | undefined>,
): InterpolationResult {
  const missing: string[] = [];
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") {
      return node.replace(VAR_PATTERN, (placeholder, name: string) => {
        const resolved = env[name];
        if (resolved === undefined) {
          if (!missing.includes(name)) missing.push(name);
          return placeholder;
        }
        return resolved;
      });
    }
    if (Array.isArray(node)) return node.map(visit);
    if (isRecord(node)) {
      return Object.fromEntries(Object.entries(node).map(([key, entry]) => [key, visit(entry)]));
    }
    return node;
  };
  return { value: visit(value), missing };
}

/**
 * Reads the gitignored `.mate/config/plugins.local.yaml`, a `plugins:` map
 * keyed by package name. A missing or malformed file yields no overrides.
 */
export async function readLocalPluginOverrides(
  companionPath: string,
): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(pluginLocalOverridesPath(companionPath), "utf8");
    const parsed = parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.plugins)) return {};
    return parsed.plugins;
  } catch {
    return {};
  }
}

export type EffectivePluginConfigResult =
  | { ok: true; config: unknown }
  | { ok: false; missingVariables: string[] };

/**
 * Computes the config passed to a plugin factory: committed `config` block,
 * deep-merged with the local override entry for the package, then `${VAR}`
 * interpolated from the environment. Resolved values are never written back.
 */
export async function resolveEffectivePluginConfig(
  companionPath: string,
  declaration: PluginDeclaration,
  env: Record<string, string | undefined> = process.env,
): Promise<EffectivePluginConfigResult> {
  const overrides = await readLocalPluginOverrides(companionPath);
  const merged = deepMergePluginConfig(declaration.config, overrides[declaration.package]);
  const { value, missing } = interpolateEnvVars(merged, env);
  if (missing.length > 0) return { ok: false, missingVariables: missing };
  return { ok: true, config: value };
}
