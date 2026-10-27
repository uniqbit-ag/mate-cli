import path from "node:path";

import type { ClaudeHookGroup } from "./claude-hook-group";
import type { SessionKind } from "./session-kind";
import { NOT_WRAPPED, readWrapStateSync, type WrapState } from "./wrap-state";

/**
 * Claude Delivery Plan: the owner of each Claude contribution, as one pure
 * function. Callers act on it and decide no ownership. In `runtime/` so hooks
 * may import it.
 */

export interface ClaudeDeliveryPlan {
  /** Capability hook groups; `launchSettingsExclude` is what `--settings` must not repeat. */
  readonly hooks: {
    readonly owner: "wrap" | "settings" | "none";
    readonly launchSettingsExclude: readonly ClaudeHookGroup[];
  };
  /** Mate MCP servers. */
  readonly mcp: "wrap" | "mcp-config" | "none";
  /** Companion directory access. */
  readonly dirAccess: "wrap" | "add-dir" | "none";
  /** Wrap reconciliation. */
  readonly reconcile: "attended-prepare" | "prepare-hook" | "none";
  /** Companion Git synchronization. */
  readonly gitSync: "launch-preflight" | "prepare-hook" | "banner";
  /**
   * Plugin folders loaded as Claude plugins. A managed launch passes Mate's
   * bundled plugin and every gathered Capability folder but `launchExclude`,
   * the folders the wrap carries; a Claude-wrapped plain session gets those
   * from the wrap alone.
   */
  readonly plugins: {
    readonly owner: "launch-flag" | "wrap" | "none";
    readonly launchExclude: readonly string[];
  };
  /** Companion Instructions, per thread kind; `dirAccess` through settings loads no memory file. */
  readonly instructions: ClaudeInstructionOwners;
}

export interface ClaudeInstructionOwners {
  /** `wrap-session-hook`: the wrap's session-prepare hook, once it has prepared, for a launch and a plain session alike. */
  readonly main: "native-memory" | "wrap-session-hook" | "none";
  /** `plugin-subagent-hook`: the bundled plugin's SubagentStart copy; `wrap-subagent-hook`: the wrap's. */
  readonly subagents: "plugin-subagent-hook" | "native-memory" | "wrap-subagent-hook" | "none";
}

/**
 * Whether the session's launch passes `--plugin-dir`: every managed launch does, a plain
 * session cannot. Not whether the session loads plugin folders: a Claude-wrapped plain
 * session gets them from the wrap.
 */
export function launchPassesClaudePluginFolders(kind: SessionKind): boolean {
  return kind !== "unmanaged";
}

export function planClaudeDelivery(kind: SessionKind, wrap: WrapState): ClaudeDeliveryPlan {
  return {
    ...planChannels(kind, wrap),
    plugins: planPlugins(kind, wrap),
    instructions: planClaudeInstructions(kind, wrap.runtimes.has("claude")),
  };
}

/**
 * The instruction owners alone, for a hook that knows its wrap without reading
 * one: a wrap-carried hook runs only because a Claude wrap installed it, maybe
 * the main checkout's, so it must not gate on this Checkout's manifest.
 */
export function planClaudeInstructions(
  kind: SessionKind,
  wrappedForClaude: boolean,
): ClaudeInstructionOwners {
  switch (kind) {
    case "managed-repo":
      return { main: "wrap-session-hook", subagents: "plugin-subagent-hook" };
    case "managed-companion":
      return { main: "native-memory", subagents: "native-memory" };
    case "unmanaged":
      return wrappedForClaude
        ? { main: "wrap-session-hook", subagents: "wrap-subagent-hook" }
        : { main: "none", subagents: "none" };
  }
}

/**
 * The folders a managed launch passes with `--plugin-dir`, in order: the
 * bundled plugin, then each gathered folder the wrap does not carry, matched
 * by resolved path. None when the launch flag does not own plugin folders.
 */
export function launchPluginFolders(
  plan: ClaudeDeliveryPlan,
  gathered: readonly string[],
  bundledPluginRoot: string,
): string[] {
  if (plan.plugins.owner !== "launch-flag") return [];
  const carried = new Set(plan.plugins.launchExclude.map((dir) => path.resolve(dir)));
  return [bundledPluginRoot, ...gathered.filter((dir) => !carried.has(path.resolve(dir)))];
}

function planPlugins(kind: SessionKind, wrap: WrapState): ClaudeDeliveryPlan["plugins"] {
  switch (kind) {
    case "managed-repo":
      return { owner: "launch-flag", launchExclude: wrap.carriedClaudePluginDirectories };
    case "managed-companion":
      return { owner: "launch-flag", launchExclude: [] };
    case "unmanaged":
      return { owner: wrap.runtimes.has("claude") ? "wrap" : "none", launchExclude: [] };
  }
}

function planChannels(
  kind: SessionKind,
  wrap: WrapState,
): Omit<ClaudeDeliveryPlan, "plugins" | "instructions"> {
  switch (kind) {
    case "managed-repo":
      return {
        hooks: { owner: "wrap", launchSettingsExclude: wrap.carriedClaudeHookGroups },
        mcp: "wrap",
        dirAccess: "wrap",
        reconcile: "attended-prepare",
        gitSync: "launch-preflight",
      };
    case "managed-companion":
      return {
        hooks: { owner: "settings", launchSettingsExclude: [] },
        mcp: "mcp-config",
        dirAccess: "add-dir",
        reconcile: "none",
        gitSync: "launch-preflight",
      };
    case "unmanaged":
      return wrap.runtimes.has("claude")
        ? {
            hooks: { owner: "wrap", launchSettingsExclude: [] },
            mcp: "wrap",
            dirAccess: "wrap",
            reconcile: "prepare-hook",
            gitSync: "prepare-hook",
          }
        : {
            hooks: { owner: "none", launchSettingsExclude: [] },
            mcp: "none",
            dirAccess: "none",
            reconcile: "none",
            gitSync: "banner",
          };
  }
}

/** For session-start hooks: a plain session's plan from a lenient read; no root, not wrapped. */
export function unmanagedClaudeDelivery(repoRoot: string | undefined): ClaudeDeliveryPlan {
  return planClaudeDelivery("unmanaged", repoRoot ? readWrapStateSync(repoRoot) : NOT_WRAPPED);
}
