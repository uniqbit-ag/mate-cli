import path from "node:path";

import { runtimeOpenCodePluginRoot } from "../../runtime/runtime-directory";
import {
  CLAUDE_LOCAL_CONFIG_DOCUMENT,
  CLAUDE_SETTINGS_DOCUMENT,
  OPENCODE_CONFIG_DOCUMENT,
  OPENCODE_MCP_SERVERS_AT,
  type ManagedRegion,
  type RenderedRuntimeDocument,
} from "../../runtime/runtime-document-manifest";
import type { CapabilityContributionInput, SetupContext } from "./plugin";
import {
  mateBannerHookGroups,
  mateGuardHookGroups,
  mateGuidanceHookGroups,
  mateSessionPrepareHookGroups,
} from "./providers/claude-plugin-hooks";
import {
  MANAGED_CLAUDE_DENY_ENTRIES,
  MANAGED_CLAUDE_FORCED_SETTINGS,
  renderManagedClaudeHookGroups,
  renderManagedClaudeMcpServers,
  renderManagedClaudePermissionEntries,
} from "./providers/claude";
import {
  renderCompanionExternalDirectoryPermissions,
  renderManagedOpenCodeMcpServers,
} from "./providers/opencode";
import { isRecord, readOpenCodeConfig } from "./providers/opencode-format";
import { projectionRepoRoot } from "./surface-target";

/**
 * The working target's documents, rendered as values. Each is a document the
 * runtime finds by walking up from the current directory, and every path inside
 * one still names the Companion Repository — only where the document is placed
 * differs from the companion target.
 */

export { CLAUDE_LOCAL_CONFIG_DOCUMENT };

function nonEmpty(region: ManagedRegion): boolean {
  if (region.kind === "list") return region.values.length > 0;
  if (region.kind === "map") return Object.keys(region.entries).length > 0;
  return true;
}

function document(documentPath: string, regions: ManagedRegion[]): RenderedRuntimeDocument[] {
  const kept = regions.filter(nonEmpty);
  return kept.length > 0 ? [{ path: documentPath, regions: kept }] : [];
}

/**
 * The Mate plugin root is what makes an Unmanaged OpenCode session load the
 * companion guidance at all: OpenCode has no config channel for a generated
 * system prompt, so the plugin is the only injection point. It is named through
 * the runtime directory, so a reinstall does not strand a wrapped repository.
 * The managed launch carries no overlay of its own, so this document is the one
 * place every OpenCode session in the repository loads it from.
 */

/**
 * Loaded by a managed session beside the launch's plugin. Mate hooks here run
 * twice there, inertly: guard is input-pure, guidance/prepare yield under a
 * launch env, banner is `--projected`. Capability groups run once: the launch
 * omits them from `--settings`. A launch passes no `--add-dir`; it relies on
 * `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` for companion `CLAUDE.md`.
 */
function claudeSettingsRegions(
  ctx: SetupContext,
  inputs: CapabilityContributionInput[],
): ManagedRegion[] {
  const capabilityHooks = renderManagedClaudeHookGroups(inputs);
  const mateHooks: Record<string, unknown[]> = {
    PreToolUse: mateGuardHookGroups(),
    SessionStart: [
      ...mateBannerHookGroups(),
      ...mateGuidanceHookGroups(),
      ...mateSessionPrepareHookGroups(),
    ],
  };
  const events = [...new Set([...Object.keys(mateHooks), ...Object.keys(capabilityHooks)])];
  return [
    ...events.map((event): ManagedRegion => ({
      at: ["hooks", event],
      kind: "list",
      values: [...(mateHooks[event] ?? []), ...(capabilityHooks[event] ?? [])],
    })),
    /**
     * `stripPrefix` heals a repository an older Mate wrapped. That version wrote
     * the whole launch environment here, and Claude Code applies `env` to the
     * session, so every hook in a bare session inherited `MATE_*` and read the
     * repository as a Managed Session — silently, since looking managed is
     * exactly what makes the guidance hook emit nothing. Guidance must be the
     * projection's to give in an Unmanaged Session, so no `MATE_*` key may
     * survive here.
     */
    {
      at: ["env"],
      kind: "map",
      entries: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" },
      stripPrefix: "MATE_",
    },
    {
      at: ["permissions", "allow"],
      kind: "list",
      values: renderManagedClaudePermissionEntries(ctx.companionPath, inputs),
    },
    { at: ["permissions", "deny"], kind: "list", values: [...MANAGED_CLAUDE_DENY_ENTRIES] },
    /**
     * Yields: the document is the user's, so their own `enableArtifact` wins,
     * and unwrapping restores it instead of deleting a key Mate overwrote.
     */
    ...Object.entries(MANAGED_CLAUDE_FORCED_SETTINGS).map(([key, value]): ManagedRegion => ({
      at: [key],
      kind: "value",
      value,
      yields: true,
    })),
  ];
}

export function renderDocumentsForTarget(
  ctx: SetupContext,
  inputsByRuntime: Map<string, CapabilityContributionInput[]>,
): RenderedRuntimeDocument[] {
  const repoRoot = projectionRepoRoot(ctx);

  const documents: RenderedRuntimeDocument[] = [];
  if (ctx.activeProviders.includes("claude")) {
    const inputs = inputsByRuntime.get("claude") ?? [];
    documents.push(...document(CLAUDE_SETTINGS_DOCUMENT, claudeSettingsRegions(ctx, inputs)));
    /**
     * Local scope, not `.mcp.json`: a project-scoped server is inert until a
     * human approves it in a session, which an Unmanaged Session is exactly the
     * case that cannot rely on. The repo path is the key Claude Code files a
     * project under, resolved so a symlinked working directory still matches.
     *
     * Confirmed against a real `~/.claude.json`: the keys there are the
     * directories sessions started in, not repository roots — sibling
     * directories of one checkout each hold their own entry, as do temporary
     * directories. So this reaches exactly one session: the one started at the
     * repository root. A session started in a subdirectory of a wrapped
     * repository has its own key, finds no `mcpServers` under it, and sees none
     * of these servers — the Unmanaged Session case this document exists for,
     * missed. That limit is deliberate. The directories a session might start
     * in are unbounded, and every one of them would be a fresh entry in the
     * user's global configuration that nothing later reclaims; keying the
     * repository root only keeps the projection's footprint there to a single
     * key. A subdirectory session still gets the rest of the projection — the
     * documents inside the repository are found by the runtime's own upward
     * walk — it loses only the MCP servers.
     */
    documents.push(
      ...document(CLAUDE_LOCAL_CONFIG_DOCUMENT, [
        {
          at: ["projects", repoRoot, "mcpServers"],
          kind: "map",
          entries: renderManagedClaudeMcpServers(inputs),
        },
      ]),
    );
  }
  if (ctx.activeProviders.includes("opencode")) {
    const inputs = inputsByRuntime.get("opencode") ?? [];
    documents.push(
      ...document(OPENCODE_CONFIG_DOCUMENT, [
        {
          at: ["plugins"],
          kind: "list",
          values: [runtimeOpenCodePluginRoot()],
        },
        {
          at: [...OPENCODE_MCP_SERVERS_AT],
          kind: "map",
          entries: renderManagedOpenCodeMcpServers(inputs),
        },
        {
          at: ["permissions"],
          kind: "list",
          values: renderCompanionExternalDirectoryPermissions(ctx.companionPath),
        },
        {
          at: ["skills"],
          kind: "list",
          values: [path.join(ctx.companionPath, ".agents", "skills")],
        },
        { at: ["references"], kind: "map", entries: { mate: ctx.companionPath } },
      ]),
    );
  }
  return documents;
}

/** Keys Mate renders its own regions for; the companion's values join those regions. */
const MATE_OPENCODE_KEYS = new Set(["plugins", "permissions", "skills", "mcp", "references"]);

function relativePathValues(value: unknown, at: string[]): string[] {
  if (typeof value === "string") {
    return value.startsWith("./") || value.startsWith("../") ? [at.join(".")] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => relativePathValues(entry, [...at, String(index)]));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, entry]) => relativePathValues(entry, [...at, key]));
  }
  return [];
}

/** Replaces the region at `at` with what `merge` builds from it, or appends one. */
function upsertRegion(
  regions: ManagedRegion[],
  at: string[],
  merge: (found: ManagedRegion | undefined) => ManagedRegion,
): void {
  const key = JSON.stringify(at);
  const index = regions.findIndex((region) => JSON.stringify(region.at) === key);
  if (index === -1) regions.push(merge(undefined));
  else regions[index] = merge(regions[index]);
}

/** Mate's own values stay; companion values it does not already list go first. */
function mergeListRegion(regions: ManagedRegion[], at: string[], extra: unknown[]): void {
  upsertRegion(regions, at, (found) => {
    const own = found?.kind === "list" ? found.values : [];
    const seen = new Set(own.map((value) => JSON.stringify(value)));
    const values = [...extra.filter((value) => !seen.has(JSON.stringify(value))), ...own];
    return { at, kind: "list", values };
  });
}

/** Mate's own entries win over companion entries of the same name. */
function mergeMapRegion(
  regions: ManagedRegion[],
  at: string[],
  extra: Record<string, unknown>,
): void {
  upsertRegion(regions, at, (found) => {
    const own = found?.kind === "map" ? found.entries : {};
    return { at, kind: "map", entries: { ...extra, ...own } };
  });
}

/** Relative reference paths resolved against the companion's `.opencode/`. */
function resolveReferences(
  references: Record<string, unknown>,
  companionDir: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(references).map(([name, reference]) => [
      name,
      typeof reference === "string" && !path.isAbsolute(reference)
        ? path.resolve(companionDir, reference)
        : reference,
    ]),
  );
}

/**
 * Folds the companion's `.opencode/opencode.json` into the wrapped document.
 * Mate's regions beat companion values; other top-level keys yield to the
 * repository's. `references` resolve against the companion's `.opencode/`;
 * other relative paths are reported, not rewritten.
 */
export async function mergeCompanionOpenCodeConfig(
  companionPath: string,
  documents: RenderedRuntimeDocument[],
): Promise<{ documents: RenderedRuntimeDocument[]; warnings: string[] }> {
  const index = documents.findIndex((document) => document.path === OPENCODE_CONFIG_DOCUMENT);
  const companionConfigPath = path.join(companionPath, ".opencode", "opencode.json");
  const companion = index === -1 ? null : await readOpenCodeConfig(companionConfigPath);
  if (!companion?.present) return { documents, warnings: [] };

  const regions = [...documents[index]!.regions] as ManagedRegion[];
  const warnings: string[] = [];

  const companionDir = path.dirname(companionConfigPath);
  for (const [key, value] of Object.entries(companion.config)) {
    if (key === "$schema") continue;
    if (key === "references" && isRecord(value)) {
      mergeMapRegion(regions, ["references"], resolveReferences(value, companionDir));
      continue;
    }
    for (const at of relativePathValues(value, [key])) {
      warnings.push(
        `${companionConfigPath}: ${at} is a relative path, which resolves against the working repository once merged into ${OPENCODE_CONFIG_DOCUMENT}; use an absolute path.`,
      );
    }
    if (MATE_OPENCODE_KEYS.has(key)) {
      if (key === "mcp" && isRecord(value) && isRecord(value.servers)) {
        mergeMapRegion(regions, [...OPENCODE_MCP_SERVERS_AT], value.servers);
      } else if (Array.isArray(value)) {
        mergeListRegion(regions, [key], value);
      }
      continue;
    }
    regions.push({ at: [key], kind: "value", value, yields: true });
  }

  const next = [...documents];
  next[index] = { path: OPENCODE_CONFIG_DOCUMENT, regions };
  return { documents: next, warnings };
}
