import path from "node:path";

// Session-runtime policy text builders. This module must stay on the
// runtime side of core (see runtime/import-isolation.test.ts): the OpenCode
// plugin builds guidance in-process from here, so no framework internals may
// leak into its import graph. `playbooks/companion-guidance` wraps these with
// the CLI-side defaults (FRAMEWORK_NAME, resolved wrapper path).

export interface PolicyCapabilityConfig {
  name: string;
}

/**
 * Session identity the policy text is rendered from. Previously the launch
 * adapters' AdapterContext; sessions are no longer spawned by Mate, so
 * activation hooks build it from the resolved companion instead.
 */
export interface CompanionSessionContext {
  repository: { id: string; path: string };
  allowedAgents: string[];
  companionPath: string;
  capabilities?: PolicyCapabilityConfig[];
  git?: string;
}

export interface PolicyTextOptions {
  wrapperBinPath: string;
  frameworkName?: string;
}

export const GRAPHIFY_SHARED_COMPANION_PATH_CONTRACT =
  "$MATE_ARTIFACT_PATH/.graphify/$MATE_REPO_ID/graphify-out/";

const hasCapability = (capabilities: PolicyCapabilityConfig[] | undefined, name: string) =>
  (capabilities ?? []).some((capability) => capability.name === name);

export function buildCodebaseExplorationGuidanceSection(
  options: {
    useGraphify?: boolean;
    useTokensave?: boolean;
    frameworkName?: string;
  } = {},
): string {
  const { useGraphify = false, useTokensave = false, frameworkName = "mate" } = options;

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
<post-edit>After code changes, run ${frameworkName} cap index.</post-edit>
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
<post-edit>After code changes, run ${frameworkName} cap index --graphify.</post-edit>
</codebase-exploration-rules>`;
  }

  return `<codebase-exploration-rules priority="mandatory">
<trigger>Codebase-understanding: architecture, tracing, integrations, impact, "how does X work?"</trigger>
<order>tokensave -> grep/glob/read. MUST try tokensave before raw source.
1. tokensave_context first.
2. Use grep/glob/read only after tokensave is empty or irrelevant.</order>
<post-edit>After code changes, run ${frameworkName} cap index --tokensave.</post-edit>
</codebase-exploration-rules>`;
}

/**
 * Build just the `<companion-policy>` XML block: paths, CLI tools, and
 * mandatory rules (including the capability-gated `openspec-finish` rule).
 */
export function buildCompanionPolicyXml(
  context: CompanionSessionContext,
  options: PolicyTextOptions,
): string {
  const wrapperBinPath = options.wrapperBinPath;
  const frameworkName = options.frameworkName ?? "mate";
  const lines = [
    "## MANDATORY RULES - NON-NEGOTIABLE",
    "",
    `<companion-policy framework="${frameworkName}" priority="mandatory">`,
    `  <overview>You are operating inside the ${frameworkName} companion repository.</overview>`,
    "  <context>",
    "    <paths>",
    `      <path role="working-repository" env="MATE_REPO_PATH">${context.repository.path}</path>`,
    `      <path role="companion-repository" env="MATE_ARTIFACT_PATH">${context.companionPath}</path>`,
    `      <path role="package-wrapper-bin" env="MATE_WRAPPER_BIN_PATH">${wrapperBinPath}</path>`,
    "    </paths>",
    "    <cli-tools>",
    `      <cli name="openspec" type="wrapper" invokeAs="${path.join(wrapperBinPath, "openspec")}" />`,
    `      <cli name="graphify" type="wrapper" invokeAs="${path.join(wrapperBinPath, "graphify")}" />`,
    `      <cli name="${frameworkName}" type="global" invokeAs="${frameworkName}" />`,
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

  if (hasCapability(context.capabilities, "openspec")) {
    lines.push(
      `    <rule id="openspec-finish" severity="critical">Finish OpenSpec changes by archiving them: the archive triggers a nudge directing you to run ${frameworkName} artifact finish "<name>" --json — if no nudge arrives, invoke that command yourself. It is the only sanctioned completion; never hand-commit or hand-tag a finish. Finishing a still-active change archives it and applies its delta specs itself, so do not pre-apply them to openspec/specs right before finishing. Finishing an already-archived change resumes without re-applying delta specs, so an archive flow that already synced specs (e.g. openspec-sync-specs) composes fine with a finish afterwards.</rule>`,
    );
  }

  lines.push("  </mandatory-rules>");

  lines.push("</companion-policy>");

  return lines.join("\n");
}

/**
 * Build the merged single-string guidance: the companion-policy XML plus
 * codebase-exploration guidance appended when graphify or tokensave is
 * enabled.
 */
export function buildCompanionGuidance(
  context: CompanionSessionContext,
  options: PolicyTextOptions,
): string {
  const lines = [buildCompanionPolicyXml(context, options)];

  const graphifyEnabled = hasCapability(context.capabilities, "graphify");
  const tokensaveEnabled = hasCapability(context.capabilities, "tokensave");

  if (graphifyEnabled || tokensaveEnabled) {
    lines.push(
      "",
      buildCodebaseExplorationGuidanceSection({
        useGraphify: graphifyEnabled,
        useTokensave: tokensaveEnabled,
        frameworkName: options.frameworkName,
      }),
    );
  }

  return lines.join("\n");
}
