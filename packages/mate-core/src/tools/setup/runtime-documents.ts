import {
  CLAUDE_LOCAL_CONFIG_DOCUMENT,
  CLAUDE_MCP_DOCUMENT,
  CLAUDE_SETTINGS_DOCUMENT,
  OPENCODE_CONFIG_DOCUMENT,
} from "../../lib/orchestrator/projection-runtime-documents";
import type {
  ManagedRegion,
  RenderedRuntimeDocument,
} from "../../lib/orchestrator/projection-types";
import { getOpenCodePluginPackageReference } from "../../lib/opencode-plugin-package";
import type { CapabilityContributionInput, SetupContext } from "./plugin";
import {
  mateBannerHookGroups,
  mateGuardHookGroups,
  mateGuidanceHookGroups,
} from "./providers/claude-plugin-hooks";
import {
  renderManagedClaudeMcpServers,
  renderManagedClaudePermissionEntries,
} from "./providers/claude";
import {
  renderCompanionExternalDirectoryPermissions,
  renderManagedOpenCodeMcpServers,
} from "./providers/opencode";
import { projectionRepoRoot } from "./surface-target";

/**
 * The working target's documents, rendered as values. Each is a document the
 * runtime finds by walking up from the current directory, and every path inside
 * one still names the Companion Repository — only where the document is placed
 * differs from the companion target.
 */

export {
  CLAUDE_LOCAL_CONFIG_DOCUMENT,
  CLAUDE_MCP_DOCUMENT,
  CLAUDE_SETTINGS_DOCUMENT,
  OPENCODE_CONFIG_DOCUMENT,
};

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
 * The Mate plugin reference is what makes an Unmanaged OpenCode session load
 * the companion guidance at all: OpenCode has no config channel for a generated
 * system prompt, so the plugin is the only injection point, and a bare session
 * loads no companion config to find it in.
 *
 * A managed launch does load the plugin twice — its `OPENCODE_CONFIG_DIR` names
 * the companion, whose config carries the same reference. That is inert rather
 * than doubled: the plugin skips its own emission when the companion-policy
 * marker is already in the prompt.
 */

/**
 * Capability hook groups stay companion-only. A managed session loads this
 * document as its `local` source *alongside* the companion's, so anything here
 * that the launch also delivers runs twice; the guard, the guidance hook and
 * the banner are the contributions whose absence is a correctness hole and
 * whose double run is inert — the guard because its verdict depends only on the
 * tool input, the guidance hook because it yields nothing under a launch
 * environment, and the banner because the copy carried here is flagged
 * `--projected` and defers to the one the launch's own plugin prints.
 *
 * `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is what a managed launch sets
 * beside `--add-dir`. Without it the companion directories this document
 * already permits are reachable but their `CLAUDE.md` is not loaded, so the
 * permission alone delivers no guidance.
 */
function claudeSettingsRegions(
  ctx: SetupContext,
  inputs: CapabilityContributionInput[],
): ManagedRegion[] {
  return [
    { at: ["hooks", "PreToolUse"], kind: "list", values: mateGuardHookGroups() },
    {
      at: ["hooks", "SessionStart"],
      kind: "list",
      values: [...mateBannerHookGroups(), ...mateGuidanceHookGroups()],
    },
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
          at: ["plugin"],
          kind: "list",
          values: [getOpenCodePluginPackageReference()],
        },
        { at: ["mcp"], kind: "map", entries: renderManagedOpenCodeMcpServers(inputs) },
        {
          at: ["permission", "external_directory"],
          kind: "map",
          entries: renderCompanionExternalDirectoryPermissions(ctx.companionPath),
        },
      ]),
    );
  }
  return documents;
}
