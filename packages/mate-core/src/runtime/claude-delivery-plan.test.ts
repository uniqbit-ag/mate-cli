import { describe, expect, test } from "bun:test";

import {
  claudePluginDelivery,
  planClaudeDelivery,
  type ClaudeDeliveryPlan,
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
      plugins: "launch-flag",
    };
  }
  if (kind === "managed-companion") {
    return {
      hooks: { owner: "settings", launchSettingsExclude: [] },
      mcp: "mcp-config",
      dirAccess: "add-dir",
      reconcile: "none",
      gitSync: "launch-preflight",
      plugins: "launch-flag",
    };
  }
  return wrap.runtimes.has("claude")
    ? {
        hooks: { owner: "wrap", launchSettingsExclude: [] },
        mcp: "wrap",
        dirAccess: "wrap",
        reconcile: "prepare-hook",
        gitSync: "prepare-hook",
        plugins: "none",
      }
    : {
        hooks: { owner: "none", launchSettingsExclude: [] },
        mcp: "none",
        dirAccess: "none",
        reconcile: "none",
        gitSync: "banner",
        plugins: "none",
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

  test.each(CASES)("%s, %s, gives each contribution at most one owner", (kind, _label, wrap) => {
    const plan = planClaudeDelivery(kind, wrap);
    const owners: Record<keyof ClaudeDeliveryPlan, unknown> = {
      hooks: plan.hooks.owner,
      mcp: plan.mcp,
      dirAccess: plan.dirAccess,
      reconcile: plan.reconcile,
      gitSync: plan.gitSync,
      plugins: plan.plugins,
    };
    expect(Object.keys(plan).sort()).toEqual(Object.keys(owners).sort());
    for (const owner of Object.values(owners)) expect(typeof owner).toBe("string");
  });

  test.each(KINDS)("%s delivers plugin folders the same way in every wrap state", (kind) => {
    const owners = new Set(
      Object.values(WRAPS).map((wrap) => planClaudeDelivery(kind, wrap).plugins),
    );
    expect(owners.size).toBe(1);
    expect(planClaudeDelivery(kind, WRAPS["Claude-wrapped"]!).plugins).toBe(
      claudePluginDelivery(kind),
    );
  });

  test("plugin folders load by launch flag in managed launches only", () => {
    expect(claudePluginDelivery("managed-repo")).toBe("launch-flag");
    expect(claudePluginDelivery("managed-companion")).toBe("launch-flag");
    expect(claudePluginDelivery("unmanaged")).toBe("none");
  });

  test("a managed launch excludes exactly the groups the wrap carries", () => {
    const plan = planClaudeDelivery("managed-repo", WRAPS["Claude-wrapped"]!);
    expect(plan.hooks.launchSettingsExclude).toEqual([GUARD]);
  });
});
