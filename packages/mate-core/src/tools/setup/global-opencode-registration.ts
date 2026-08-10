import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getOpenCodePluginPackageReference,
  isMateOpenCodePluginReference,
} from "../../lib/opencode-plugin-package";

/**
 * OpenCode's global (user-scope) config location: `$XDG_CONFIG_HOME/opencode/
 * opencode.json`, defaulting to `~/.config`. This resolves the design's
 * config-location open question — the XDG path is OpenCode's documented
 * global config across versions; project-scoped config stays untouched.
 */
export function globalOpenCodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim()
    ? env.XDG_CONFIG_HOME
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode", "opencode.json");
}

export interface GlobalOpenCodeRegistrationDeps {
  configPath?: string;
  tuiConfigPath?: string;
  pluginReference?: string;
}

/** Reconcile one config file's `plugin` array to carry exactly one Mate reference. */
async function upsertPluginReference(configPath: string, reference: string): Promise<void> {
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    /* absent or unparseable — start fresh */
  }

  const existing = Array.isArray(config.plugin) ? (config.plugin as unknown[]) : [];
  const plugin = [...existing.filter((entry) => !isMateOpenCodePluginReference(entry)), reference];

  const next = JSON.stringify({ ...config, plugin }, null, 2) + "\n";
  try {
    if ((await fs.readFile(configPath, "utf8")) === next) return;
  } catch {
    /* absent — write below */
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, next, "utf8");
}

/**
 * Register the Mate OpenCode plugin package in the user's global OpenCode
 * configuration so it loads in every session without a Mate launcher. Stale
 * Mate references (older pinned versions) are replaced; unmanaged plugin
 * entries and all other config keys are preserved.
 *
 * OpenCode >= 1.18 loads server plugins from `opencode.json` but TUI plugins
 * only from the separate `tui.json` config, so the reference is written to
 * both — otherwise the TUI entrypoint is never imported.
 */
export async function registerMateOpenCodePluginGlobally(
  deps: GlobalOpenCodeRegistrationDeps = {},
): Promise<void> {
  const configPath = deps.configPath ?? globalOpenCodeConfigPath();
  const tuiConfigPath = deps.tuiConfigPath ?? path.join(path.dirname(configPath), "tui.json");
  const reference = deps.pluginReference ?? getOpenCodePluginPackageReference();

  await upsertPluginReference(configPath, reference);
  await upsertPluginReference(tuiConfigPath, reference);
}
