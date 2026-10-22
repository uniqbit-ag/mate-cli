import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Hides Claude Code's commit and PR attribution, so a session is never told to
 * add a model `Co-Authored-By` trailer. The object form, never `false`: Claude
 * Code before v2.1.281 rejects `false` and drops the whole settings file, and
 * Mate's permissions and guard hooks with it.
 */
export const MANAGED_CLAUDE_ATTRIBUTION = Object.freeze({
  commit: "",
  pr: "",
  sessionUrl: false,
});

/** Claude Code's user config directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeUserConfigDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured) return path.normalize(configured);
  return path.join(env.HOME || os.homedir(), ".claude");
}

export interface ClaudeAttributionScopes {
  /** Defaults to {@link claudeUserConfigDir}. */
  userConfigDir?: string;
  /** The Working Repository, when known: adds its project and local settings. */
  repoRoot?: string;
}

function readSettings(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether `value` is Mate's own attribution rather than one the user set. */
export function isManagedClaudeAttribution(value: unknown): boolean {
  return isDeepStrictEqual(value, MANAGED_CLAUDE_ATTRIBUTION);
}

/**
 * Whether a checked scope sets attribution itself, so Mate's value must yield.
 * Mate's own wrapped value sits in the same `settings.local.json` the user
 * edits; deep-equality with it is what tells the two apart.
 */
export function definesUserClaudeAttribution(scopes: ClaudeAttributionScopes): boolean {
  const files = [path.join(scopes.userConfigDir ?? claudeUserConfigDir(), "settings.json")];
  if (scopes.repoRoot) {
    files.push(
      path.join(scopes.repoRoot, ".claude", "settings.json"),
      path.join(scopes.repoRoot, ".claude", "settings.local.json"),
    );
  }
  return files.some((file) => {
    const settings = readSettings(file);
    if (!settings) return false;
    if ("includeCoAuthoredBy" in settings) return true;
    return "attribution" in settings && !isManagedClaudeAttribution(settings.attribution);
  });
}
