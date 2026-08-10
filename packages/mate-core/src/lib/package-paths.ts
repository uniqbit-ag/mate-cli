import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { getActiveDistribution } from "../distribution";

const require = createRequire(import.meta.url);

/**
 * Resolved wrapper directory: a distribution asset root that ships
 * `wrappers/bin` wins over core's bundled default.
 */
export function getWrapperBinPath(): string {
  for (const root of getActiveDistribution().config.assetRoots ?? []) {
    const candidate = path.join(root, "wrappers", "bin");
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(import.meta.dirname, "../../wrappers/bin");
}

/**
 * Wrapper path for processes with no active distribution (plugins loaded by
 * an agent host, hooks in sessions Mate did not spawn): falls back to core's
 * packaged default instead of throwing.
 */
export function getWrapperBinPathSafe(): string {
  try {
    return getWrapperBinPath();
  } catch {
    return path.resolve(import.meta.dirname, "../../wrappers/bin");
  }
}

/**
 * Resolved bundled Claude plugin root: a distribution asset root that ships
 * `claude-plugin/` wins over core's bundled default. Loaded per managed
 * launch via `claude --plugin-dir`, so hooks always match the installed
 * mate-core version.
 */
export function getClaudePluginRoot(): string {
  for (const root of getActiveDistribution().config.assetRoots ?? []) {
    const candidate = path.join(root, "claude-plugin");
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(import.meta.dirname, "../../claude-plugin");
}

export const CLAUDE_PLUGIN_HOOK_SHIMS = [
  "validate-artifact-path.mjs",
  "session-activation.mjs",
  "artifact-finish-nudge.mjs",
] as const;

/**
 * Verify the bundled Claude plugin assets exist. Throws naming the missing
 * assets; managed launches must not start without the artifact-path guard.
 */
export function validateClaudePluginAssets(pluginRoot = getClaudePluginRoot()): void {
  const expected = [
    path.join(".claude-plugin", "plugin.json"),
    path.join("hooks", "hooks.json"),
    path.join("hooks", "ts-loader.mjs"),
    ...CLAUDE_PLUGIN_HOOK_SHIMS.map((shim) => path.join("hooks", shim)),
  ];
  const missing = expected.filter((asset) => !fs.existsSync(path.join(pluginRoot, asset)));
  if (missing.length > 0) {
    throw new Error(`bundled Claude plugin at ${pluginRoot} is missing: ${missing.join(", ")}`);
  }
}

export function getReactDoctorBinPath(): string {
  try {
    const entryPath = require.resolve("react-doctor");
    return path.resolve(path.dirname(entryPath), "../bin/react-doctor.js");
  } catch {
    return path.resolve(import.meta.dirname, "../../node_modules/.bin/react-doctor");
  }
}
