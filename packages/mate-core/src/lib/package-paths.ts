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

const CLAUDE_PLUGIN_HOOK_SHIMS = [
  "validate-artifact-path.mjs",
  "session-banner.mjs",
  "session-guidance.mjs",
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

/**
 * Resolved bundled OpenCode plugin root: a distribution asset root that ships
 * `opencode-plugin/` wins over core's bundled default. Machine-local, so it
 * reaches OpenCode only through the launch overlay and the git-excluded
 * projection, never a committed config.
 */
export function getOpenCodePluginRoot(): string {
  for (const root of getActiveDistribution().config.assetRoots ?? []) {
    const candidate = path.join(root, "opencode-plugin");
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(import.meta.dirname, "../../opencode-plugin");
}

/** Root entries OpenCode resolves for a plugin referenced by directory path. */
const OPENCODE_PLUGIN_ENTRIES = ["server.ts", "tui.tsx"] as const;

/**
 * Verify the bundled OpenCode plugin entries exist. Throws naming the missing
 * entries; `companion setup` cannot restore package files, so the fix is a reinstall.
 */
export function validateOpenCodePluginAssets(pluginRoot = getOpenCodePluginRoot()): void {
  const missing = OPENCODE_PLUGIN_ENTRIES.filter(
    (entry) => !fs.existsSync(path.join(pluginRoot, entry)),
  );
  if (missing.length > 0) {
    throw new Error(
      `bundled OpenCode plugin at ${pluginRoot} is missing: ${missing.join(", ")}. Reinstall Mate to restore it.`,
    );
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
