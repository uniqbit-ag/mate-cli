import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../../framework";
import { PLUGIN_DECLARATION_POLICIES } from "../../../lib/orchestrator/config-store";
import type { PluginDeclaration } from "../../../lib/orchestrator/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Raw read of the companion's `plugins:` list. Deliberately avoids
 * `ConfigStore.load()` — hydration runs on every invocation and must never
 * create or migrate config files as a side effect.
 */
export async function readDeclarations(companionPath: string): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(
      path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
      "utf8",
    );
    const parsed = parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) return [];
    return parsed.plugins;
  } catch {
    return [];
  }
}

export function validateDeclaration(entry: unknown): {
  declaration?: PluginDeclaration;
  error?: string;
} {
  if (!isRecord(entry) || typeof entry.package !== "string" || typeof entry.version !== "string") {
    return { error: `ignoring malformed plugins entry: ${JSON.stringify(entry)}` };
  }
  const policy = entry.policy;
  if (policy !== undefined && !PLUGIN_DECLARATION_POLICIES.includes(policy as never)) {
    return {
      error: `plugin "${entry.package}": policy "${String(policy)}" is not allowed for declared plugins (allowed: ${PLUGIN_DECLARATION_POLICIES.join(", ")}).`,
    };
  }
  return { declaration: entry as unknown as PluginDeclaration };
}
