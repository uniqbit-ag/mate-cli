import fs from "node:fs";
import path from "node:path";

import { getClaudePluginRoot } from "../../../lib/package-paths";
import type { ClaudeHookGroup } from "./claude-format";

/**
 * The bundled Claude plugin's hook wiring, read as a value. A managed launch
 * loads it with `--plugin-dir`; an Unmanaged Session loads no plugin dir at
 * all, so the working-target settings document has to carry it instead.
 *
 * Only the artifact-path guard is carried over. A managed session loads the
 * Working Repository's settings as its `local` source *alongside* the plugin,
 * so every group here runs twice there — which the guard tolerates (its verdict
 * is a function of the tool input alone) and the session banner and the archive
 * nudge do not, since both emit.
 */

const GUARD_HOOK_SHIM = "validate-artifact-path.mjs";
const PLUGIN_ROOT_TOKEN = "${CLAUDE_PLUGIN_ROOT}";

interface PluginHookWiring {
  hooks?: Record<string, ClaudeHookGroup[]>;
}

function readPluginHookWiring(pluginRoot: string): PluginHookWiring {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
    ) as unknown;
    if (parsed && typeof parsed === "object") return parsed as PluginHookWiring;
  } catch {
    /* an installation missing its plugin assets contributes no hooks */
  }
  return {};
}

function resolveCommands(group: ClaudeHookGroup, pluginRoot: string): ClaudeHookGroup {
  return {
    ...group,
    hooks: (group.hooks ?? []).map((hook) => ({
      ...hook,
      ...(hook.command ? { command: hook.command.split(PLUGIN_ROOT_TOKEN).join(pluginRoot) } : {}),
    })),
  };
}

function isGuardGroup(group: ClaudeHookGroup): boolean {
  return (group.hooks ?? []).some((hook) => (hook.command ?? "").includes(GUARD_HOOK_SHIM));
}

/**
 * The guard's `PreToolUse` groups with `${CLAUDE_PLUGIN_ROOT}` resolved against
 * the running installation, so the command works with no launch environment.
 */
export function mateGuardHookGroups(pluginRoot: string = getClaudePluginRoot()): ClaudeHookGroup[] {
  return (readPluginHookWiring(pluginRoot).hooks?.PreToolUse ?? [])
    .filter(isGuardGroup)
    .map((group) => resolveCommands(group, pluginRoot));
}

/**
 * Whether a hook group is one the working target placed. It matches a managed
 * marker, so the entry that strips managed groups from a Working Repository has
 * to be told to leave these alone.
 */
export function isMateGuardHookGroup(group: ClaudeHookGroup): boolean {
  const own = new Set(mateGuardHookGroups().map((candidate) => JSON.stringify(candidate)));
  return own.has(JSON.stringify(group));
}
