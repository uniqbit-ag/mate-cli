import type { ClaudeHookGroup } from "./claude-hook-group";
import { NOT_WRAPPED, readWrapStateSync, type WrapState } from "./wrap-state";

/**
 * Claude Delivery Plan: the owner of each Claude contribution, as one pure
 * function. Callers act on it and decide no ownership. In `runtime/` so hooks
 * may import it.
 */

/**
 * `managed-repo`: `mate claude` with a Working Repository; its prepare just
 * reconciled the Claude wrap, which the launcher asserts. `managed-companion`:
 * a companion-scoped launch. `unmanaged`: a session with no launch environment.
 */
export type SessionKind = "managed-repo" | "managed-companion" | "unmanaged";

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
}

export function planClaudeDelivery(kind: SessionKind, wrap: WrapState): ClaudeDeliveryPlan {
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
