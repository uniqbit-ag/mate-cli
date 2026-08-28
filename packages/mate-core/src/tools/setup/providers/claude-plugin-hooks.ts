import fs from "node:fs";
import path from "node:path";

import { PROJECTED_BANNER_FLAG } from "../../../hooks/session-banner";
import { getClaudePluginRoot } from "../../../lib/package-paths";
import type { ClaudeHookGroup } from "./claude-format";

/**
 * The bundled Claude plugin's hook wiring, read as a value. A managed launch
 * loads it with `--plugin-dir`; an Unmanaged Session loads no plugin dir at
 * all, so the working-target settings document has to carry it instead.
 *
 * A managed session loads the Working Repository's settings as its `local`
 * source *alongside* the plugin, so every group carried over runs twice there.
 * Three survive that: the guard, whose verdict is a function of the tool input
 * alone; the guidance hook, which yields nothing when a launch environment is
 * present and so cannot double the prompt the launch already appended; and the
 * banner, whose carried copy is marked so it defers to the launch's. The
 * archive nudge stays companion-only — it emits unconditionally, and its gate
 * reads launch-only variables an Unmanaged Session never has anyway.
 */

const GUARD_HOOK_SHIM = "validate-artifact-path.mjs";
const GUIDANCE_HOOK_SHIM = "session-guidance.mjs";
const BANNER_HOOK_SHIM = "session-banner.mjs";
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

function runsShim(shim: string): (group: ClaudeHookGroup) => boolean {
  return (group) => (group.hooks ?? []).some((hook) => (hook.command ?? "").includes(shim));
}

function groupsFor(
  event: string,
  shim: string,
  pluginRoot: string = getClaudePluginRoot(),
): ClaudeHookGroup[] {
  return (readPluginHookWiring(pluginRoot).hooks?.[event] ?? [])
    .filter(runsShim(shim))
    .map((group) => resolveCommands(group, pluginRoot));
}

/**
 * The guard's `PreToolUse` groups with `${CLAUDE_PLUGIN_ROOT}` resolved against
 * the running installation, so the command works with no launch environment.
 */
export function mateGuardHookGroups(pluginRoot: string = getClaudePluginRoot()): ClaudeHookGroup[] {
  return groupsFor("PreToolUse", GUARD_HOOK_SHIM, pluginRoot);
}

/**
 * The guidance hook's `SessionStart` groups, resolved the same way. This is the
 * channel that replaces `--append-system-prompt` where no launch supplies one:
 * a settings document can declare a hook, and there is no settings key for the
 * flag.
 */
export function mateGuidanceHookGroups(
  pluginRoot: string = getClaudePluginRoot(),
): ClaudeHookGroup[] {
  return groupsFor("SessionStart", GUIDANCE_HOOK_SHIM, pluginRoot);
}

/**
 * The banner's `SessionStart` group, resolved the same way and carrying
 * `PROJECTED_BANNER_FLAG`. Without the marker the carried command would be
 * byte-identical to the plugin's, and a managed session — which loads both —
 * would print the banner twice.
 */
export function mateBannerHookGroups(
  pluginRoot: string = getClaudePluginRoot(),
): ClaudeHookGroup[] {
  return groupsFor("SessionStart", BANNER_HOOK_SHIM, pluginRoot).map((group) => ({
    ...group,
    hooks: (group.hooks ?? []).map((hook) => ({
      ...hook,
      ...(hook.command ? { command: `${hook.command} ${PROJECTED_BANNER_FLAG}` } : {}),
    })),
  }));
}

/**
 * Whether a hook group is one the working target placed. It matches a managed
 * marker, so the entry that strips managed groups from a Working Repository has
 * to be told to leave these alone.
 */
export function isMateGuardHookGroup(group: ClaudeHookGroup): boolean {
  const own = new Set(
    [...mateGuardHookGroups(), ...mateGuidanceHookGroups(), ...mateBannerHookGroups()].map(
      (candidate) => JSON.stringify(candidate),
    ),
  );
  return own.has(JSON.stringify(group));
}
