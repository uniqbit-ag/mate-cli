import { describe, expect, test } from "bun:test";

import {
  launchPassesClaudePluginFolders,
  launchPluginFolders,
  planClaudeDelivery,
  type ClaudeDeliveryPlan,
} from "./claude-delivery-plan";
import {
  CLAUDE_SETTINGS_DOCUMENT,
  EMPTY_MANIFEST,
  OPENCODE_CONFIG_DOCUMENT,
  withDocument,
} from "./runtime-document-manifest";
import type { SessionKind } from "./session-kind";
import { wrapStateOf, type WrapState } from "./wrap-state";

const GUARD = { matcher: "Edit", hooks: [{ type: "command", command: "/acme/guard.mjs" }] };
const ACME_PLUGIN = "/plugins/acme";

const WRAPS: Record<string, WrapState> = {
  "Claude-wrapped": wrapStateOf(
    withDocument(EMPTY_MANIFEST, CLAUDE_SETTINGS_DOCUMENT, [
      { at: ["hooks", "PreToolUse"], kind: "list", values: [GUARD] },
      {
        at: ["extraKnownMarketplaces"],
        kind: "map",
        entries: { "mate-plugin-acme": { source: { source: "directory", path: ACME_PLUGIN } } },
      },
      { at: ["enabledPlugins"], kind: "map", entries: { "acme@mate-plugin-acme": true } },
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
      plugins: { owner: "launch-flag", launchExclude: wrap.carriedClaudePluginDirectories },
    };
  }
  if (kind === "managed-companion") {
    return {
      hooks: { owner: "settings", launchSettingsExclude: [] },
      mcp: "mcp-config",
      dirAccess: "add-dir",
      reconcile: "none",
      gitSync: "launch-preflight",
      plugins: { owner: "launch-flag", launchExclude: [] },
    };
  }
  return wrap.runtimes.has("claude")
    ? {
        hooks: { owner: "wrap", launchSettingsExclude: [] },
        mcp: "wrap",
        dirAccess: "wrap",
        reconcile: "prepare-hook",
        gitSync: "prepare-hook",
        plugins: { owner: "wrap", launchExclude: [] },
      }
    : {
        hooks: { owner: "none", launchSettingsExclude: [] },
        mcp: "none",
        dirAccess: "none",
        reconcile: "none",
        gitSync: "banner",
        plugins: { owner: "none", launchExclude: [] },
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
      plugins: plan.plugins.owner,
    };
    expect(Object.keys(plan).sort()).toEqual(Object.keys(owners).sort());
    for (const owner of Object.values(owners)) expect(typeof owner).toBe("string");
  });

  test("only a managed launch passes plugin folders by launch flag", () => {
    expect(launchPassesClaudePluginFolders("managed-repo")).toBe(true);
    expect(launchPassesClaudePluginFolders("managed-companion")).toBe(true);
    expect(launchPassesClaudePluginFolders("unmanaged")).toBe(false);
    for (const kind of KINDS) {
      for (const wrap of Object.values(WRAPS)) {
        expect(planClaudeDelivery(kind, wrap).plugins.owner === "launch-flag").toBe(
          launchPassesClaudePluginFolders(kind),
        );
      }
    }
  });

  test("a managed launch in a repository leaves the folders the wrap carries to the wrap", () => {
    const plan = planClaudeDelivery("managed-repo", WRAPS["Claude-wrapped"]!);
    expect(plan.plugins.launchExclude).toEqual([ACME_PLUGIN]);
  });

  test("a companion-scoped launch passes every folder, whatever a wrap carries", () => {
    const plan = planClaudeDelivery("managed-companion", WRAPS["Claude-wrapped"]!);
    expect(plan.plugins).toEqual({ owner: "launch-flag", launchExclude: [] });
  });

  test("a plain session gets plugin folders from a Claude wrap only", () => {
    expect(planClaudeDelivery("unmanaged", WRAPS["Claude-wrapped"]!).plugins.owner).toBe("wrap");
    expect(planClaudeDelivery("unmanaged", WRAPS["OpenCode-only"]!).plugins.owner).toBe("none");
    expect(planClaudeDelivery("unmanaged", WRAPS["not wrapped"]!).plugins.owner).toBe("none");
  });

  test("a managed launch excludes exactly the groups the wrap carries", () => {
    const plan = planClaudeDelivery("managed-repo", WRAPS["Claude-wrapped"]!);
    expect(plan.hooks.launchSettingsExclude).toEqual([GUARD]);
  });
});

const BUNDLED = "/mate/claude-plugin";
const ALPHA = "/plugins/alpha";

describe("launchPluginFolders", () => {
  const CASES: readonly (readonly [string, SessionKind, WrapState, readonly string[], string[]])[] =
    [
      [
        "a launch in a repository leaves the folders its wrap carries to the wrap",
        "managed-repo",
        WRAPS["Claude-wrapped"]!,
        [ACME_PLUGIN, ALPHA],
        [BUNDLED, ALPHA],
      ],
      [
        "a carried folder gathered with a trailing separator is still left to the wrap",
        "managed-repo",
        WRAPS["Claude-wrapped"]!,
        [`${ACME_PLUGIN}/`, ALPHA],
        [BUNDLED, ALPHA],
      ],
      [
        "a folder the wrap does not carry is still passed",
        "managed-repo",
        WRAPS["Claude-wrapped"]!,
        [ALPHA],
        [BUNDLED, ALPHA],
      ],
      [
        "a companion-scoped launch passes every gathered folder, whatever a wrap carries",
        "managed-companion",
        WRAPS["Claude-wrapped"]!,
        [ACME_PLUGIN, ALPHA],
        [BUNDLED, ACME_PLUGIN, ALPHA],
      ],
      [
        "gathered folders follow the bundled plugin in gathered order",
        "managed-repo",
        WRAPS["not wrapped"]!,
        [ACME_PLUGIN, ALPHA],
        [BUNDLED, ACME_PLUGIN, ALPHA],
      ],
      [
        "a launch that gathered no folder passes only the bundled plugin",
        "managed-repo",
        WRAPS["Claude-wrapped"]!,
        [],
        [BUNDLED],
      ],
      [
        "a path with a space and a drive letter passes through unchanged",
        "managed-repo",
        WRAPS["Claude-wrapped"]!,
        ["C:\\Users\\Acme Corp\\plugins\\acme"],
        [BUNDLED, "C:\\Users\\Acme Corp\\plugins\\acme"],
      ],
      [
        "a plain session in a Claude wrap passes none: the wrap owns them",
        "unmanaged",
        WRAPS["Claude-wrapped"]!,
        [ALPHA],
        [],
      ],
      [
        "a plain session without a Claude wrap passes none",
        "unmanaged",
        WRAPS["not wrapped"]!,
        [ALPHA],
        [],
      ],
    ];

  test.each(CASES)("%s", (_label, kind, wrap, gathered, folders) => {
    expect(launchPluginFolders(planClaudeDelivery(kind, wrap), gathered, BUNDLED)).toEqual(folders);
  });
});
