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
  /** Plugin folders loaded as Claude plugins: Mate's bundled plugin and Capability plugin directories. */
  readonly plugins: ClaudePluginDelivery;
}

export type ClaudePluginDelivery = "launch-flag" | "none";

/** No settings document can carry a plugin folder, so the wrap state never matters. */
export function claudePluginDelivery(kind: SessionKind): ClaudePluginDelivery {
  return kind === "unmanaged" ? "none" : "launch-flag";
}

export function planClaudeDelivery(kind: SessionKind, wrap: WrapState): ClaudeDeliveryPlan {
  return { ...planChannels(kind, wrap), plugins: claudePluginDelivery(kind) };
}

function planChannels(kind: SessionKind, wrap: WrapState): Omit<ClaudeDeliveryPlan, "plugins"> {
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
