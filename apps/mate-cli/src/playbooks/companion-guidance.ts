import path from "node:path";

import { frameworkConfig } from "../framework";
import type { AdapterContext } from "../lib/orchestrator/adapters/base";
import {
  hasGraphifyCapability,
  hasOpenspecCapability,
  hasTokensaveCapability,
} from "../lib/orchestrator/capabilities";
import { getWrapperBinPath } from "../lib/package-paths";

export { hasGraphifyCapability, hasTokensaveCapability } from "../lib/orchestrator/capabilities";

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
<post-edit>After code changes, run mate cap index.</post-edit>
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
<post-edit>After code changes, run mate cap index --graphify.</post-edit>
</codebase-exploration-rules>`;
  }

  return `<codebase-exploration-rules priority="mandatory">
<trigger>Codebase-understanding: architecture, tracing, integrations, impact, "how does X work?"</trigger>
<order>tokensave -> grep/glob/read. MUST try tokensave before raw source.
1. tokensave_context first.
2. Use grep/glob/read only after tokensave is empty or irrelevant.</order>
<post-edit>After code changes, run mate cap index --tokensave.</post-edit>
</codebase-exploration-rules>`;
}

export function buildCompanionGuidance(
  context: AdapterContext,
  options: { wrapperBinPath?: string } = {},
): string {
  const name = frameworkConfig.name;
  const wrapperBinPath = options.wrapperBinPath ?? getWrapperBinPath();
  const lines = [
    "## MANDATORY RULES - NON-NEGOTIABLE",
    "",
    `<companion-policy framework="${name}" priority="mandatory">`,
    `  <overview>You are operating inside the ${name} companion repository.</overview>`,
    "  <context>",
    "    <paths>",
    `      <path role="working-repository" env="MATE_REPO_PATH">${context.repository.path}</path>`,
    `      <path role="companion-repository" env="MATE_ARTIFACT_PATH">${context.companionPath}</path>`,
    `      <path role="package-wrapper-bin" env="MATE_WRAPPER_BIN_PATH">${wrapperBinPath}</path>`,
    "    </paths>",
    "    <cli-tools>",
    `      <cli name="openspec" type="wrapper" invokeAs="${path.join(wrapperBinPath, "openspec")}" />`,
    `      <cli name="graphify" type="wrapper" invokeAs="${path.join(wrapperBinPath, "graphify")}" />`,
    '      <cli name="mate" type="global" invokeAs="mate" />',
    "    </cli-tools>",
    `    <linked-repository id="${context.repository.id}" profile="${context.repository.profile}" />`,
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
      '    <rule id="openspec-finish" severity="critical">Finish OpenSpec changes ONLY with: mate artifact finish "<name>" --json — never hand-commit or hand-tag a finish. Finishing a still-active change applies its delta specs itself, so do not pre-apply them to openspec/specs right before finishing. Finishing an already-archived change resumes without re-applying delta specs, so an archive flow that already synced specs (e.g. openspec-sync-specs) composes fine with a finish afterwards.</rule>',
    );
  }

  lines.push("  </mandatory-rules>");

  lines.push("</companion-policy>");

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
