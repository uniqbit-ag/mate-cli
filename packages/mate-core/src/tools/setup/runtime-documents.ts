import {
  CLAUDE_MCP_DOCUMENT,
  CLAUDE_SETTINGS_DOCUMENT,
  OPENCODE_CONFIG_DOCUMENT,
} from "../../lib/orchestrator/projection-runtime-documents";
import type {
  ManagedRegion,
  RenderedRuntimeDocument,
} from "../../lib/orchestrator/projection-types";
import type { CapabilityContributionInput, SetupContext } from "./plugin";
import { mateGuardHookGroups } from "./providers/claude-plugin-hooks";
import {
  renderManagedClaudeMcpServers,
  renderManagedClaudePermissionEntries,
} from "./providers/claude";
import {
  renderCompanionExternalDirectoryPermissions,
  renderManagedOpenCodeMcpServers,
} from "./providers/opencode";
import { projectionTarget } from "./surface-target";

/**
 * The working target's documents, rendered as values. Each is a document the
 * runtime finds by walking up from the current directory, and every path inside
 * one still names the Companion Repository — only where the document is placed
 * differs from the companion target.
 */

export { CLAUDE_MCP_DOCUMENT, CLAUDE_SETTINGS_DOCUMENT, OPENCODE_CONFIG_DOCUMENT };

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
 * The Mate plugin reference stays out of the OpenCode document: a managed
 * launch points `OPENCODE_CONFIG_DIR` at the companion, whose config already
 * carries it, and a second reference in the project config would load the
 * plugin twice. Companion access and MCP servers merge as maps, so they cannot.
 */

/**
 * Capability hook groups stay companion-only. A managed session loads this
 * document as its `local` source *alongside* the companion's, so anything here
 * that the launch also delivers runs twice; the guard is the one contribution
 * whose absence is a correctness hole and whose double run is inert.
 */
function claudeSettingsRegions(
  ctx: SetupContext,
  inputs: CapabilityContributionInput[],
): ManagedRegion[] {
  return [
    { at: ["hooks", "PreToolUse"], kind: "list", values: mateGuardHookGroups() },
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
  projectionTarget(ctx);

  const documents: RenderedRuntimeDocument[] = [];
  if (ctx.activeProviders.includes("claude")) {
    const inputs = inputsByRuntime.get("claude") ?? [];
    documents.push(...document(CLAUDE_SETTINGS_DOCUMENT, claudeSettingsRegions(ctx, inputs)));
    documents.push(
      ...document(CLAUDE_MCP_DOCUMENT, [
        { at: ["mcpServers"], kind: "map", entries: renderManagedClaudeMcpServers(inputs) },
      ]),
    );
  }
  if (ctx.activeProviders.includes("opencode")) {
    const inputs = inputsByRuntime.get("opencode") ?? [];
    documents.push(
      ...document(OPENCODE_CONFIG_DOCUMENT, [
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
