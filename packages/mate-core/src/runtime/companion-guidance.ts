import path from "node:path";

import { FRAMEWORK_NAME } from "./framework";
import { GUIDANCE_FILE_VERSION, type MateGuidanceFile } from "./guidance";

/**
 * The guidance builders, on the session-runtime side of core.
 *
 * They live here rather than under `playbooks/` because a hook shim and the
 * OpenCode plugin both have to build guidance without a launch, and both may
 * only reach `runtime/` — the import-isolation tests enforce that. What kept
 * them out was a single resolved default, `getWrapperBinPath()`; taking the
 * path as data instead makes the whole set pure. `playbooks/companion-guidance`
 * still supplies that default for the framework-side callers.
 */

/**
 * What guidance actually reads off a launch context. Structurally satisfied by
 * `AdapterContext`, so a launch passes its own context unchanged, and equally
 * by a value composed from the projection.
 */
export interface GuidanceCapability {
  name: string;
}

export interface GuidanceContext {
  companionPath: string;
  repository: { id: string; path: string };
  capabilities?: GuidanceCapability[];
}

export function hasGraphifyCapability(capabilities: GuidanceCapability[] = []): boolean {
  return capabilities.some((capability) => capability.name === "graphify");
}

export function hasOpenspecCapability(capabilities: GuidanceCapability[] = []): boolean {
  return capabilities.some((capability) => capability.name === "openspec");
}

export function hasTokensaveCapability(capabilities: GuidanceCapability[] = []): boolean {
  return capabilities.some((capability) => capability.name === "tokensave");
}

export const GRAPHIFY_SHARED_COMPANION_PATH_CONTRACT =
  "$MATE_ARTIFACT_PATH/.graphify/$MATE_REPO_ID/graphify-out/";

export function buildCodebaseExplorationGuidanceSection(
  options: {
    useGraphify?: boolean;
    useTokensave?: boolean;
  } = {},
): string {
  const { useGraphify = false, useTokensave = false } = options;

  if (!useGraphify && !useTokensave) {
    return "";
  }

  if (useGraphify && useTokensave) {
    return `<codebase-exploration-rules priority="mandatory">
<path role="graphify-out">${GRAPHIFY_SHARED_COMPANION_PATH_CONTRACT}</path>
<trigger>Codebase-understanding: architecture, tracing, integrations, impact, "how does X work?"</trigger>
<order>tokensave -> graphify -> grep/glob/read. MUST NOT skip steps.
1. tokensave_context first.
2. If tokensave is empty/file-only/irrelevant, run graphify query "<question>"; use graphify path/explain to deepen.
3. Use grep/glob/read only after tokensave and graphify were tried.</order>
<notes>Dirty graph files are expected. Use wiki/index.md for broad navigation; GRAPH_REPORT.md only if query/path/explain fall short.</notes>
<post-edit>After code changes, run ${FRAMEWORK_NAME} cap index.</post-edit>
</codebase-exploration-rules>`;
  }

  if (useGraphify) {
    return `<codebase-exploration-rules priority="mandatory">
<path role="graphify-out">${GRAPHIFY_SHARED_COMPANION_PATH_CONTRACT}</path>
<trigger>Codebase-understanding: architecture, tracing, integrations, impact, "how does X work?"</trigger>
<order>graphify -> grep/glob/read. MUST try graphify before raw source.
1. graphify query "<question>" first.
2. Use graphify path "<A>" "<B>" or graphify explain "<concept>" to deepen.
3. Use grep/glob/read only after graphify was tried.</order>
<notes>Dirty graph files are expected. Use wiki/index.md for broad navigation; GRAPH_REPORT.md only if query/path/explain fall short.</notes>
<post-edit>After code changes, run ${FRAMEWORK_NAME} cap index --graphify.</post-edit>
</codebase-exploration-rules>`;
  }

  return `<codebase-exploration-rules priority="mandatory">
<trigger>Codebase-understanding: architecture, tracing, integrations, impact, "how does X work?"</trigger>
<order>tokensave -> grep/glob/read. MUST try tokensave before raw source.
1. tokensave_context first.
2. Use grep/glob/read only after tokensave is empty or irrelevant.</order>
<post-edit>After code changes, run ${FRAMEWORK_NAME} cap index --tokensave.</post-edit>
</codebase-exploration-rules>`;
}

/**
 * Build just the `<companion-policy>` XML block: paths, CLI tools, and
 * mandatory rules (including the capability-gated `openspec-finish` rule).
 * Does not include codebase-exploration guidance — see
 * `buildCompanionGuidance` for the merged single-string form, or call
 * `buildCodebaseExplorationGuidanceSection` directly when that guidance is
 * delivered through its own channel (as OpenCode's guidance contract does).
 */
export function buildCompanionPolicyXml(
  context: GuidanceContext,
  options: { wrapperBinPath: string },
): string {
  const { wrapperBinPath } = options;
  const lines = [
    "## MANDATORY RULES - NON-NEGOTIABLE",
    "",
    `<companion-policy framework="${FRAMEWORK_NAME}" priority="mandatory">`,
    `  <overview>You are operating inside the ${FRAMEWORK_NAME} companion repository.</overview>`,
    "  <context>",
    "    <paths>",
    `      <path role="working-repository" env="MATE_REPO_PATH">${context.repository.path}</path>`,
    `      <path role="companion-repository" env="MATE_ARTIFACT_PATH">${context.companionPath}</path>`,
    `      <path role="package-wrapper-bin" env="MATE_WRAPPER_BIN_PATH">${wrapperBinPath}</path>`,
    "    </paths>",
    "    <cli-tools>",
    `      <cli name="openspec" type="wrapper" invokeAs="${path.join(wrapperBinPath, "openspec")}" />`,
    `      <cli name="graphify" type="wrapper" invokeAs="${path.join(wrapperBinPath, "graphify")}" />`,
    `      <cli name="${FRAMEWORK_NAME}" type="global" invokeAs="${FRAMEWORK_NAME}" />`,
    "    </cli-tools>",
    `    <linked-repository id="${context.repository.id}" />`,
    "  </context>",
    "  <mandatory-rules>",
    `    <rule id="artifact-location" severity="critical">Agent artifacts MUST go to ${context.companionPath}, NEVER ${context.repository.path}. Artifacts include plans, specs, ADRs, todos, notes, handoffs, reasoning docs, and scratch files.</rule>`,
    `    <rule id="pre-write-classification" severity="critical">Before ANY write, classify the target as product-code or agent-artifact. If unsure, treat it as agent-artifact.</rule>`,
    `    <rule id="product-code-location" severity="critical">Product code (README, docs, source, tests) belongs in ${context.repository.path}. Agent-artifacts belong in ${context.companionPath}.</rule>`,
    `    <rule id="local-artifact-exception" severity="critical">Only write artifacts in ${context.repository.path} when the exact path is gitignored AND intentionally local-only; otherwise use ${context.companionPath}.</rule>`,
    `    <rule id="guardrail" severity="critical">Bad artifact writes to ${context.repository.path} are rejected. Classify correctly first.</rule>`,
    `    <rule id="wrapper-only-cli-execution" severity="critical">For every CLI declared in cli-tools, invoke the exact path in its invokeAs attribute. Correct: ${path.join(wrapperBinPath, "openspec")} status ... . Incorrect: openspec status ... . Do not run bare openspec or graphify commands and do not rely on PATH, aliases, or shell functions. If the exact wrapper path is unavailable, stop and report it.</rule>`,
  ];

  if (hasOpenspecCapability(context.capabilities)) {
    lines.push(
      `    <rule id="openspec-finish" severity="critical">Finish OpenSpec changes by archiving them: the archive triggers a nudge directing you to run ${FRAMEWORK_NAME} artifact finish "<name>" --json — if no nudge arrives, invoke that command yourself. It is the only sanctioned completion; never hand-commit or hand-tag a finish. Finishing a still-active change archives it and applies its delta specs itself, so do not pre-apply them to openspec/specs right before finishing. Finishing an already-archived change resumes without re-applying delta specs, so an archive flow that already synced specs (e.g. openspec-sync-specs) composes fine with a finish afterwards.</rule>`,
    );
  }

  lines.push("  </mandatory-rules>");

  lines.push("</companion-policy>");

  return lines.join("\n");
}

/**
 * Build the merged single-string guidance: the companion-policy XML plus
 * codebase-exploration guidance appended when graphify or tokensave is
 * enabled. Used by providers (e.g. Claude) that inject one combined prompt
 * fragment rather than delivering exploration guidance separately.
 */
export function buildCompanionGuidance(
  context: GuidanceContext,
  options: { wrapperBinPath: string },
): string {
  const lines = [buildCompanionPolicyXml(context, options)];

  const graphifyEnabled = hasGraphifyCapability(context.capabilities);
  const tokensaveEnabled = hasTokensaveCapability(context.capabilities);

  if (graphifyEnabled || tokensaveEnabled) {
    lines.push(
      "",
      buildCodebaseExplorationGuidanceSection({
        useGraphify: graphifyEnabled,
        useTokensave: tokensaveEnabled,
      }),
    );
  }

  return lines.join("\n");
}

/**
 * Build the companion guidance payload the OpenCode plugin consumes, whether
 * delivered through `MATE_GUIDANCE_JSON` by a launch or built from the
 * Projection Root by the plugin itself. The text carries `$MATE_*`
 * placeholders the plugin materializes from its own resolved context, so the
 * same payload shape serves every companion and no path is resolved here.
 *
 * Real capabilities are passed through (not just the graphify/tokensave flags)
 * so capability-gated companion-policy rules — e.g. openspec-finish — render
 * exactly as they do for the Claude provider.
 */
export function buildOpenCodeGuidance(capabilities: GuidanceCapability[]): MateGuidanceFile {
  const companionGuidance = buildCompanionPolicyXml(
    {
      companionPath: "$MATE_ARTIFACT_PATH",
      repository: { id: "$MATE_REPO_ID", path: "$MATE_REPO_PATH" },
      capabilities,
    },
    { wrapperBinPath: "$MATE_WRAPPER_BIN_PATH" },
  );
  const graphifyEnabled = hasGraphifyCapability(capabilities);
  const tokensaveEnabled = hasTokensaveCapability(capabilities);
  const codebaseExplorationGuidance = buildCodebaseExplorationGuidanceSection({
    useGraphify: graphifyEnabled,
    useTokensave: tokensaveEnabled,
  });
  const errors: string[] = [];

  if (!companionGuidance.includes("<companion-policy ")) {
    errors.push("companion guidance was not injected");
  }
  if (
    (graphifyEnabled || tokensaveEnabled) &&
    !codebaseExplorationGuidance.includes("<codebase-exploration-rules ")
  ) {
    errors.push("codebase exploration guidance was not injected");
  }

  return {
    version: GUIDANCE_FILE_VERSION,
    companionGuidance,
    codebaseExplorationGuidance,
    errors,
  };
}
