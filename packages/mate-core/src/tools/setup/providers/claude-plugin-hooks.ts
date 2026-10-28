import fs from "node:fs";
import path from "node:path";

import { getClaudePluginRoot } from "../../../lib/package-paths";
import { PROJECTED_FLAG } from "../../../runtime/projected-flag";
import { runtimeClaudePluginRoot } from "../../../runtime/runtime-directory";
import { hookGroupKey, type ClaudeHookGroup } from "./claude-format";

/**
 * The bundled Claude plugin's hook wiring, read as a value. A managed launch
 * loads it with `--plugin-dir`; an Unmanaged Session loads no plugin dir at
 * all, so the working-target settings document has to carry it instead.
 *
 * A managed session loads the Working Repository's settings as its `local`
 * source *alongside* the plugin, so every group carried over runs twice there;
 * a plain session may load both too, through `--plugin-dir`. The guard is
 * input-pure, the guidance hook yields under a launch environment, and the
 * banner, prepare and SubagentStart instruction copies carried here hold
 * `PROJECTED_FLAG`, so one copy of each acts.
 *
 * The wiring is read from the installed plugin, but every command names
 * `<mate home>/runtime/claude-plugin`, so a reinstall or Node switch does not
 * strand a wrapped repository.
 */

const GUARD_HOOK_SHIM = "validate-artifact-path.mjs";
const GUIDANCE_HOOK_SHIM = "session-guidance.mjs";
const BANNER_HOOK_SHIM = "session-banner.mjs";
const PREPARE_HOOK_SHIM = "session-prepare.mjs";
const INSTRUCTIONS_HOOK_SHIM = "companion-instructions.mjs";
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

function mapCommands(
  group: ClaudeHookGroup,
  rewrite: (command: string) => string,
): ClaudeHookGroup {
  return {
    ...group,
    hooks: (group.hooks ?? []).map((hook) => ({
      ...hook,
      ...(hook.command ? { command: rewrite(hook.command) } : {}),
    })),
  };
}

function resolveCommands(group: ClaudeHookGroup, pluginRoot: string): ClaudeHookGroup {
  return mapCommands(group, (command) => command.split(PLUGIN_ROOT_TOKEN).join(pluginRoot));
}

function runsShim(group: ClaudeHookGroup, shim: string): boolean {
  return (group.hooks ?? []).some((hook) => (hook.command ?? "").includes(shim));
}

function groupsFor(event: string, shim: string, commandRoot: string): ClaudeHookGroup[] {
  return (readPluginHookWiring(getClaudePluginRoot()).hooks?.[event] ?? []).flatMap((group) =>
    runsShim(group, shim) ? [resolveCommands(group, commandRoot)] : [],
  );
}

/**
 * The guard's `PreToolUse` groups with `${CLAUDE_PLUGIN_ROOT}` resolved against
 * the runtime link, so the command works with no launch environment.
 */
export function mateGuardHookGroups(
  commandRoot: string = runtimeClaudePluginRoot(),
): ClaudeHookGroup[] {
  return groupsFor("PreToolUse", GUARD_HOOK_SHIM, commandRoot);
}

/**
 * The guidance hook's `SessionStart` groups, resolved the same way. This is the
 * channel that replaces `--append-system-prompt` where no launch supplies one:
 * a settings document can declare a hook, and there is no settings key for the
 * flag.
 */
export function mateGuidanceHookGroups(
  commandRoot: string = runtimeClaudePluginRoot(),
): ClaudeHookGroup[] {
  return groupsFor("SessionStart", GUIDANCE_HOOK_SHIM, commandRoot);
}

/**
 * The banner's `SessionStart` group, resolved the same way and carrying
 * `PROJECTED_FLAG`. Without the marker the carried command would be
 * byte-identical to the plugin's, and a managed session — which loads both —
 * would print the banner twice.
 */
export function mateBannerHookGroups(
  commandRoot: string = runtimeClaudePluginRoot(),
): ClaudeHookGroup[] {
  return withProjectedFlag(groupsFor("SessionStart", BANNER_HOOK_SHIM, commandRoot));
}

function withProjectedFlag(groups: ClaudeHookGroup[]): ClaudeHookGroup[] {
  return groups.map((group) => mapCommands(group, (command) => `${command} ${PROJECTED_FLAG}`));
}

/**
 * The `SubagentStart` instruction group, resolved the same way and carrying
 * `PROJECTED_FLAG`: a session that loads both this copy and the plugin's,
 * through a launch or `--plugin-dir`, would otherwise deliver the instructions
 * twice.
 */
export function mateInstructionHookGroups(
  commandRoot: string = runtimeClaudePluginRoot(),
): ClaudeHookGroup[] {
  return withProjectedFlag(groupsFor("SubagentStart", INSTRUCTIONS_HOOK_SHIM, commandRoot));
}

/**
 * The session-prepare `SessionStart` group, resolved the same way. Its declared
 * `timeout` sits above the shim's own bound, so Claude Code never kills a
 * prepare the shim has not given up on. It carries `PROJECTED_FLAG`: this copy
 * alone prepares, which it skips under a launch environment, and then delivers
 * the main thread's instructions; the plugin's copy stays inert.
 */
export function mateSessionPrepareHookGroups(
  commandRoot: string = runtimeClaudePluginRoot(),
): ClaudeHookGroup[] {
  return withProjectedFlag(groupsFor("SessionStart", PREPARE_HOOK_SHIM, commandRoot));
}

function mateOwnHookGroups(commandRoot: string): ClaudeHookGroup[] {
  return [
    ...mateGuardHookGroups(commandRoot),
    ...mateGuidanceHookGroups(commandRoot),
    ...mateBannerHookGroups(commandRoot),
    ...mateSessionPrepareHookGroups(commandRoot),
    ...mateInstructionHookGroups(commandRoot),
  ];
}

const ownGroupKeys = new Map<string, ReadonlySet<string>>();

/** Memoized per plugin-root pair; hooks are short-lived, so a refresh mid-process is not tracked. */
function mateOwnHookGroupKeys(runtimeRoot: string, installRoot: string): ReadonlySet<string> {
  const memoKey = `${runtimeRoot}\0${installRoot}`;
  let keys = ownGroupKeys.get(memoKey);
  if (!keys) {
    keys = new Set(
      [...mateOwnHookGroups(runtimeRoot), ...mateOwnHookGroups(installRoot)].map(hookGroupKey),
    );
    ownGroupKeys.set(memoKey, keys);
  }
  return keys;
}

/**
 * Whether a hook group is one the working target placed. It matches a managed
 * marker, so the entry that strips managed groups from a Working Repository has
 * to be told to leave these alone. Both the runtime-link form and the
 * install-path form an older release wrote are recognized.
 */
export function isMateGuardHookGroup(group: ClaudeHookGroup): boolean {
  return mateOwnHookGroupKeys(runtimeClaudePluginRoot(), getClaudePluginRoot()).has(
    hookGroupKey(group),
  );
}
