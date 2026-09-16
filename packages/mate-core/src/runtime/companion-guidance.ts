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
  repository?: { id: string; path: string };
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
export const GRAPHIFY_COMPANION_PATH_CONTRACT =
  "$MATE_ARTIFACT_PATH/.graphify/__companion__/graphify-out/";

export function buildCodebaseExplorationGuidanceSection(
  options: {
    useGraphify?: boolean;
    useTokensave?: boolean;
    graphifyOutContract?: string;
  } = {},
): string {
  const {
    useGraphify = false,
    useTokensave = false,
    graphifyOutContract = GRAPHIFY_SHARED_COMPANION_PATH_CONTRACT,
  } = options;

  if (!useGraphify && !useTokensave) {
    return "";
  }

  if (useGraphify && useTokensave) {
    return `<codebase-exploration-rules priority="mandatory">
<path role="graphify-out">${graphifyOutContract}</path>
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
<path role="graphify-out">${graphifyOutContract}</path>
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
 * mandatory rules (including the capability-gated `openspec-publish` rule).
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
    `      <path role="companion-repository" env="MATE_ARTIFACT_PATH">${context.companionPath}</path>`,
    `      <path role="package-wrapper-bin" env="MATE_WRAPPER_BIN_PATH">${wrapperBinPath}</path>`,
    "    </paths>",
    "    <cli-tools>",
    `      <cli name="openspec" type="wrapper" invokeAs="${path.join(wrapperBinPath, "openspec")}" />`,
    `      <cli name="graphify" type="wrapper" invokeAs="${path.join(wrapperBinPath, "graphify")}" />`,
    `      <cli name="${FRAMEWORK_NAME}" type="global" invokeAs="${FRAMEWORK_NAME}" />`,
    "    </cli-tools>",
    "  </context>",
    "  <mandatory-rules>",
    `    <rule id="wrapper-only-cli-execution" severity="critical">For every CLI declared in cli-tools, invoke the exact path in its invokeAs attribute. Correct: ${path.join(wrapperBinPath, "openspec")} status ... . Incorrect: openspec status ... . Do not run bare openspec or graphify commands and do not rely on PATH, aliases, or shell functions. If the exact wrapper path is unavailable, stop and report it.</rule>`,
  ];

  if (context.repository) {
    lines.splice(
      8,
      0,
      `      <path role="working-repository" env="MATE_REPO_PATH">${context.repository.path}</path>`,
    );
    lines.splice(
      lines.indexOf("  </context>"),
      0,
      `    <linked-repository id="${context.repository.id}" />`,
    );
    lines.splice(
      lines.indexOf("  </mandatory-rules>"),
      0,
      `    <rule id="artifact-location" severity="critical">Agent artifacts MUST go to ${context.companionPath}, NEVER ${context.repository.path}. Artifacts include plans, specs, ADRs, todos, notes, handoffs, reasoning docs, and scratch files.</rule>`,
      `    <rule id="pre-write-classification" severity="critical">Before ANY write, classify the target as product-code or agent-artifact. If unsure, treat it as agent-artifact.</rule>`,
      `    <rule id="product-code-location" severity="critical">Product code (README, docs, source, tests) belongs in ${context.repository.path}. Agent-artifacts belong in ${context.companionPath}.</rule>`,
      `    <rule id="local-artifact-exception" severity="critical">Only write artifacts in ${context.repository.path} when the exact path is gitignored AND intentionally local-only; otherwise use ${context.companionPath}.</rule>`,
      `    <rule id="guardrail" severity="critical">Bad artifact writes to ${context.repository.path} are rejected. Classify correctly first.</rule>`,
      `    <rule id="companion-multi-repository" severity="critical">This Companion Repository may serve multiple Working Repositories. The working-repository path above identifies this session's single primary Working Repository, not the companion's full repository set. The Companion Repository is the shared artifact and context plane; the primary Working Repository is the product-code plane.</rule>`,
      `    <rule id="repository-area-scope" severity="critical">For domain modeling, identify the canonical Working Repository and its repository-relative Area first. A checkout basename or Area alone is not a repository identity. Shared context applies only when the Companion Repository's CONTEXT-MAP explicitly maps it to the current repository and Area.</rule>`,
    );
  } else {
    lines.splice(
      lines.indexOf("  </mandatory-rules>"),
      0,
      "    <session>Companion-scoped launch with no Working Repository.</session>",
    );
    lines.splice(
      lines.indexOf("  </mandatory-rules>"),
      0,
      `    <rule id="artifact-location" severity="critical">Agent artifacts MUST go to ${context.companionPath}. The Companion Repository is the artifact and context plane for this session.</rule>`,
      `    <rule id="pre-write-classification" severity="critical">Before ANY write, classify the target as product-code or agent-artifact. If unsure, treat it as agent-artifact.</rule>`,
    );
  }

  if (hasOpenspecCapability(context.capabilities)) {
    lines.push(
      `    <rule id="openspec-scope" severity="critical">In OpenSpec, the frontmatter repository identifies the Working Repository. areas are repository-relative paths within that repository. Canonical specs use repository plus flat areas; change artifacts use paired scopes entries. In a monorepo, an Area normally stops at the package root. A cross-repository change may declare multiple scopes, but each resulting spec remains owned by one repository, and each requirement must bind its Area explicitly.</rule>`,
      `    <rule id="openspec-publish" severity="critical">Archiving an OpenSpec change is a local operation and publishes nothing. Publish through the mate-artifact-publish skill: it lists candidates with ${FRAMEWORK_NAME} artifact pending --json, takes an explicit user selection, confirms the commit, tag, and push, then runs ${FRAMEWORK_NAME} artifact publish "<name>" --json per selected change. That command is the only sanctioned publication; never hand-commit or hand-tag one. Publishing only publishes an already-archived change: archiving is a precondition, and running publish on a still-active change is an error that names openspec archive as the missing step. Publish never archives and never applies delta specs itself, so archive first — by the archive workflow or an already-synced flow such as openspec-sync-specs — and then publish. Publish also refuses to run anywhere but the companion's default branch.</rule>`,
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
        graphifyOutContract: context.repository
          ? GRAPHIFY_SHARED_COMPANION_PATH_CONTRACT
          : GRAPHIFY_COMPANION_PATH_CONTRACT,
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
 * so capability-gated companion-policy rules — e.g. openspec-publish — render
 * exactly as they do for the Claude provider.
 */
export function buildOpenCodeGuidance(
  capabilities: GuidanceCapability[],
  options: { companionScoped?: boolean } = {},
): MateGuidanceFile {
  const repository = options.companionScoped
    ? undefined
    : { id: "$MATE_REPO_ID", path: "$MATE_REPO_PATH" };
  const companionGuidance = buildCompanionPolicyXml(
    {
      companionPath: "$MATE_ARTIFACT_PATH",
      repository,
      capabilities,
    },
    { wrapperBinPath: "$MATE_WRAPPER_BIN_PATH" },
  );
  const graphifyEnabled = hasGraphifyCapability(capabilities);
  const tokensaveEnabled = hasTokensaveCapability(capabilities);
  const codebaseExplorationGuidance = buildCodebaseExplorationGuidanceSection({
    useGraphify: graphifyEnabled,
    useTokensave: tokensaveEnabled,
    graphifyOutContract: options.companionScoped
      ? GRAPHIFY_COMPANION_PATH_CONTRACT
      : GRAPHIFY_SHARED_COMPANION_PATH_CONTRACT,
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
