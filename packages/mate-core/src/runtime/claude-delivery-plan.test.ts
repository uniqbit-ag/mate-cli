import { describe, expect, test } from "bun:test";

import {
  planClaudeDelivery,
  type ClaudeDeliveryPlan,
  type SessionKind,
} from "./claude-delivery-plan";
import {
  CLAUDE_SETTINGS_DOCUMENT,
  EMPTY_MANIFEST,
  OPENCODE_CONFIG_DOCUMENT,
  withDocument,
} from "./runtime-document-manifest";
import { wrapStateOf, type WrapState } from "./wrap-state";

const GUARD = { matcher: "Edit", hooks: [{ type: "command", command: "/acme/guard.mjs" }] };

const WRAPS: Record<string, WrapState> = {
  "Claude-wrapped": wrapStateOf(
    withDocument(EMPTY_MANIFEST, CLAUDE_SETTINGS_DOCUMENT, [
      { at: ["hooks", "PreToolUse"], kind: "list", values: [GUARD] },
    ]),
  ),
  "OpenCode-only": wrapStateOf(withDocument(EMPTY_MANIFEST, OPENCODE_CONFIG_DOCUMENT, [])),
  "not wrapped": wrapStateOf(EMPTY_MANIFEST),
};

const KINDS: readonly SessionKind[] = ["managed-repo", "managed-companion", "unmanaged"];

/** ADR-022's ownership table; the plan must reproduce it row for row. */
function expected(kind: SessionKind, wrap: WrapState): ClaudeDeliveryPlan {
  if (kind === "managed-repo") {
    return {
      hooks: { owner: "wrap", launchSettingsExclude: wrap.carriedClaudeHookGroups },
      mcp: "wrap",
      dirAccess: "wrap",
      reconcile: "attended-prepare",
      gitSync: "launch-preflight",
    };
  }
  if (kind === "managed-companion") {
    return {
      hooks: { owner: "settings", launchSettingsExclude: [] },
      mcp: "mcp-config",
      dirAccess: "add-dir",
      reconcile: "none",
      gitSync: "launch-preflight",
    };
  }
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

const CASES = KINDS.flatMap((kind) =>
  Object.entries(WRAPS).map(([label, wrap]) => [kind, label, wrap] as const),
);

describe("planClaudeDelivery", () => {
  test.each(CASES)("%s, %s, matches the ownership table", (kind, _label, wrap) => {
    expect(planClaudeDelivery(kind, wrap)).toEqual(expected(kind, wrap));
  });

  test.each(CASES)("%s, %s, never splits one channel's work", (kind, _label, wrap) => {
    const plan = planClaudeDelivery(kind, wrap);
    /** A prepare hook that reconciles also syncs, so the banner never fetches beside it. */
    if (plan.reconcile === "prepare-hook") expect(plan.gitSync).toBe("prepare-hook");
    /** Hooks, MCP and dir access are delivered by the wrap together or not at all. */
    const byWrap = [plan.hooks.owner, plan.mcp, plan.dirAccess].filter((owner) => owner === "wrap");
    expect([0, 3]).toContain(byWrap.length);
  });

  test("a managed launch excludes exactly the groups the wrap carries", () => {
    const plan = planClaudeDelivery("managed-repo", WRAPS["Claude-wrapped"]!);
    expect(plan.hooks.launchSettingsExclude).toEqual([GUARD]);
  });
});
