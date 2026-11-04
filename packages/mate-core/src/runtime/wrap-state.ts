import fs from "node:fs";

import { hookGroupKey, type ClaudeHookGroup } from "./claude-hook-group";
import {
  CLAUDE_SETTINGS_DOCUMENT,
  EMPTY_MANIFEST,
  OPENCODE_CONFIG_DOCUMENT,
  OPENCODE_MCP_SERVERS_AT,
  copies,
  documents,
  links,
  recordedMapEntries,
  manifestPath,
  parseManifest,
  parseManifestStrict,
  readManifestText,
  recordedListValues,
  recordedMapKeys,
  type Manifest,
  type WrapRuntime,
} from "./runtime-document-manifest";

/**
 * Wrap State: the one read model over the runtime document manifest for "which
 * runtimes are wrapped" and "which Claude hook groups and plugin folders does
 * the wrap carry".
 * Mate's own plugin groups are not folded in; `isMateGuardHookGroup` owns those.
 */
export interface WrapState {
  readonly runtimes: ReadonlySet<WrapRuntime>;
  readonly carriedClaudeHookGroups: readonly ClaudeHookGroup[];
  carriesClaudeHookGroup(group: ClaudeHookGroup): boolean;
  /** Capability plugin IDs and directory marketplaces the Wrap recorded. */
  readonly carriedClaudePlugins: readonly WrappedClaudePlugin[];
  /** Capability plugin folders the wrap enables through a `directory` marketplace, as recorded. */
  readonly carriedClaudePluginDirectories: readonly string[];
  /** MCP server names the wrap declared in `.opencode/opencode.json`; user servers are not listed. */
  readonly openCodeMcpServers: readonly string[];
}

export interface WrappedClaudePlugin {
  readonly id: string;
  readonly marketplace: string;
  readonly directory: string;
}

export const WRAP_RUNTIMES: readonly WrapRuntime[] = ["claude", "opencode"];

/** Wrapped for a runtime: a document, a copy or a link is recorded for it. */
function wrappedFor(manifest: Manifest, runtime: WrapRuntime): boolean {
  return (
    documents(manifest, runtime).length > 0 ||
    Object.keys(copies(manifest, runtime)).length > 0 ||
    Object.keys(links(manifest, runtime)).length > 0
  );
}

/**
 * Each enabled plugin of a recorded `directory` marketplace: a marketplace
 * without an enabled plugin loads nothing.
 */
function carriedPlugins(manifest: Manifest): WrappedClaudePlugin[] {
  const marketplaces = recordedMapEntries(manifest, CLAUDE_SETTINGS_DOCUMENT, [
    "extraKnownMarketplaces",
  ]);
  const enabled = recordedMapEntries(manifest, CLAUDE_SETTINGS_DOCUMENT, ["enabledPlugins"]);
  return Object.entries(marketplaces).flatMap(([marketplace, entry]) => {
    const source = isRecord(entry) ? entry.source : undefined;
    if (!isRecord(source) || source.source !== "directory" || typeof source.path !== "string") {
      return [];
    }
    const directory = source.path;
    return Object.entries(enabled)
      .filter(([id, value]) => value === true && id.slice(id.lastIndexOf("@") + 1) === marketplace)
      .map(([id]) => ({ id, marketplace, directory }));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHookGroup(value: unknown): value is ClaudeHookGroup {
  return isRecord(value);
}

export function wrapStateOf(manifest: Manifest): WrapState {
  const carried = recordedListValues(manifest, CLAUDE_SETTINGS_DOCUMENT, ["hooks"]).filter(
    isHookGroup,
  );
  const carriedKeys = new Set(carried.map(hookGroupKey));
  const plugins = carriedPlugins(manifest);
  return {
    runtimes: new Set(WRAP_RUNTIMES.filter((runtime) => wrappedFor(manifest, runtime))),
    carriedClaudeHookGroups: carried,
    carriesClaudeHookGroup: (group) => carriedKeys.has(hookGroupKey(group)),
    carriedClaudePlugins: plugins,
    carriedClaudePluginDirectories: [
      ...new Map(plugins.map(({ marketplace, directory }) => [marketplace, directory])).values(),
    ],
    openCodeMcpServers: recordedMapKeys(
      manifest,
      OPENCODE_CONFIG_DOCUMENT,
      OPENCODE_MCP_SERVERS_AT,
    ),
  };
}

/** Where no Projection Root resolves: nothing is wrapped. */
export const NOT_WRAPPED: WrapState = wrapStateOf(EMPTY_MANIFEST);

/**
 * Lenient, for session-start readers that must never fail: an absent or
 * unreadable manifest reads as not wrapped.
 */
export function readWrapStateSync(repoPath: string): WrapState {
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(manifestPath(repoPath), "utf8");
  } catch {
    /* absent or unreadable: not wrapped */
  }
  return wrapStateOf(parseManifest(raw));
}

/**
 * Strict, for writers: a manifest that exists but cannot be read or parsed
 * throws, so a rewrite never strips wrap-placed content it could not see.
 */
export async function readWrapState(repoPath: string): Promise<WrapState> {
  return wrapStateOf(parseManifestStrict(await readManifestText(repoPath)));
}
