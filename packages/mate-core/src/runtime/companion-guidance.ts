import path from "node:path";

import { FRAMEWORK_NAME } from "./framework";
import { GUIDANCE_FILE_VERSION, type MateGuidanceFile } from "./guidance";
import { readWorkflow } from "./workflow/declaration";
import type { DeclaredArtifactType, WorkflowSkillStage } from "./workflow/workflow";

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
  /**
   * Whether the companion's secret guardrails are active. Absent means active:
   * a caller that cannot tell never drops the rule.
   */
  secretGuardrails?: boolean;
  /** The artifact types the companion's workflow declares; each gets its reading rule. */
  artifactTypes?: readonly GuidanceArtifactType[];
  /** The skill stages the companion declares; absent when it declares none. */
  stages?: readonly GuidanceStage[];
}

/** The paths of a declared artifact type its reading rule is built from. */
export type GuidanceArtifactType = Pick<
  DeclaredArtifactType,
  "name" | "change" | "published" | "archive"
>;

/** A declared skill stage with the skill that starts it. */
export type GuidanceStage = Pick<WorkflowSkillStage, "id" | "entry">;

export interface DeclaredGuidance {
  artifactTypes: GuidanceArtifactType[];
  stages?: GuidanceStage[];
}

/**
 * What `companionPath`'s workflow adds to the guidance: its artifact types, and its skill stages
 * when it declares `stages`. An invalid declaration adds nothing, which keeps the built-in rules
 * alone; the session banner names its problems.
 */
export function declaredGuidance(companionPath: string): DeclaredGuidance {
  const verdict = readWorkflow(companionPath);
  if (!verdict.ok) return { artifactTypes: [] };
  const { artifacts, stages } = verdict.workflow;
  const declared = stages.filter(
    (stage): stage is WorkflowSkillStage => stage.kind === "skill" && stage.source === "declared",
  );
  return {
    artifactTypes: artifacts,
    ...(declared.length > 0 ? { stages: declared.map(({ id, entry }) => ({ id, entry })) } : {}),
  };
}

/** Tells the session to run a declared stage's whole chain: no skill template knows it. */
function stagesRule(stages: readonly GuidanceStage[]): string {
  const entries = stages.map((stage) => `${stage.id} (${stage.entry})`).join(", ");
  return `    <rule id="workflow-stages" severity="critical">This companion declares its Delivery Path; each stage is started with its entry skill: ${entries}. When you run one of these skills for a change, run ${FRAMEWORK_NAME} workflow steps "<stage>" --json first. After the skill, run the stage's remaining steps in order in this session, each for the same change; when a step cannot be loaded or fails, stop and name it. Then run ${FRAMEWORK_NAME} workflow done "<stage>" "<change>" and hand off to the stage in next, in place of the one the skill names.</rule>`;
}

/** `notes/{name}/` → `notes/`. */
const folderOf = (template: string): string => template.replace(/\{[a-z]+\}\/?$/, "");

/**
 * What agents read as current for a declared type, on the model of the built-in
 * `openspec-publish` rule. Its submitted folders have no `touches`, so one is read only when named.
 */
function artifactTypeRule(type: GuidanceArtifactType): string {
  const history = type.archive ? ` ${folderOf(type.archive)} is history.` : "";
  return `    <rule id="artifact-${type.name}" severity="critical">${type.name}: ${type.published.join(", ")} is current. A submitted folder under ${folderOf(type.change)} is not the truth until publication lands it on the companion's default branch and is never current: read one only when the user names it, and revise one only when named (${FRAMEWORK_NAME} artifact take "<name>" when it is missing, then resubmit).${history}</rule>`;
}

const SECRET_HANDLING_RULE = `    <rule id="secret-handling" severity="critical">Never read, print, copy, or write secret files (.env, .env.*, keys, certificates, credential files such as .npmrc or .netrc) or secret values. To learn which variables exist, read only the example files (.env.example, .env.sample, .env.template, .env.dist). Refer to a secret by its variable name only. Do not print environment variables that may hold secrets. When a secret must be set or rotated, ask the user to do it instead of writing it yourself. Guarded calls are blocked; the companion's framework.yaml secrets block is the user's switch, not yours.</rule>`;

export function hasGraphifyCapability(capabilities: GuidanceCapability[] = []): boolean {
  return capabilities.some((capability) => capability.name === "graphify");
}

export function hasOpenspecCapability(capabilities: GuidanceCapability[] = []): boolean {
  return capabilities.some((capability) => capability.name === "openspec");
}

export function hasTokensaveCapability(capabilities: GuidanceCapability[] = []): boolean {
  return capabilities.some((capability) => capability.name === "tokensave");
}

export function hasRtkCapability(capabilities: GuidanceCapability[] = []): boolean {
  return capabilities.some((capability) => capability.name === "rtk");
}

/** Claude only: no other runtime isolates a session it moved into a worktree. */
const ENTERED_WORKTREE_GIT_RULE = `    <rule id="entered-worktree-git" severity="critical">After EnterWorktree moves this session into a linked worktree, run every git command as RTK_DISABLED=1 git ... (for example RTK_DISABLED=1 git status): Claude Code's worktree guard refuses git run through RTK there. Run other commands as usual.</rule>`;

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
 * mandatory rules (including the capability-gated `openspec-publish` rule, and
 * with `enteredWorktreeGit` the RTK-gated `entered-worktree-git` rule).
 * Does not include codebase-exploration guidance — see
 * `buildCompanionGuidance` for the merged single-string form, or call
 * `buildCodebaseExplorationGuidanceSection` directly when that guidance is
 * delivered through its own channel (as OpenCode's guidance contract does).
 */
export function buildCompanionPolicyXml(
  context: GuidanceContext,
  options: { wrapperBinPath: string; enteredWorktreeGit?: boolean },
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
      `    <rule id="artifact-location" severity="critical">Agent artifacts MUST go to ${context.companionPath}, NEVER ${context.repository.path}, which holds product code (README, docs, source, tests). Artifacts include plans, specs, ADRs, todos, notes, handoffs, reasoning docs, and scratch files.</rule>`,
      `    <rule id="pre-write-classification" severity="critical">Before ANY write, classify the target as product-code or agent-artifact. If unsure, treat it as agent-artifact.</rule>`,
      `    <rule id="local-artifact-exception" severity="critical">Write an artifact in the working repository only when its exact path is gitignored AND intentionally local-only.</rule>`,
      `    <rule id="guardrail" severity="critical">Bad artifact writes to the working repository are rejected. The guardrail resolves relative paths against ${context.repository.path} and does not follow cd, so write artifacts, including shell redirects and tee, with absolute paths under ${context.companionPath}.</rule>`,
      `    <rule id="companion-multi-repository" severity="critical">This Companion Repository may serve multiple Working Repositories; the working-repository path is this session's single primary Working Repository (the product-code plane), not the full set. The Companion Repository is the shared artifact and context plane.</rule>`,
      `    <rule id="repository-area-scope" severity="critical">For domain modeling, identify the canonical Working Repository and its repository-relative Area first. A checkout basename or Area alone is not a repository identity. Shared context applies only when the companion CONTEXT-MAP explicitly maps it to that repository and Area.</rule>`,
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

  if (context.secretGuardrails !== false) {
    lines.push(SECRET_HANDLING_RULE);
  }

  if (hasOpenspecCapability(context.capabilities)) {
    lines.push(
      `    <rule id="openspec-scope" severity="critical">In OpenSpec, the frontmatter repository identifies the Working Repository; areas are repository-relative paths within that repository. Canonical specs use repository plus flat areas; change artifacts use paired scopes entries. In a monorepo, an Area normally stops at the package root. A cross-repository change may declare multiple scopes, but each resulting spec remains owned by one repository, and each requirement must bind its Area explicitly.</rule>`,
      `    <rule id="openspec-publish" severity="critical">Submit publishes nothing: it pushes an OpenSpec change folder (state: submitted) to the inbox mate/inbox to await its merge. A submitted change is not the truth: only publication lands it on the companion's default branch. openspec/specs/ is current; ${FRAMEWORK_NAME} artifact project "<name>" shows the unpublished outcome. ${FRAMEWORK_NAME} artifact pending --json lists them with author, touched requirements, ref and path; read one (git show <ref>:<path>/<file>) only where it touches your work or the user names it; implement or revise one only when the user names it: ${FRAMEWORK_NAME} artifact take "<name>" brings it into the checkout when it is missing there, then resubmit it with mate-submit-change. Publish only through mate-publish-artifact (${FRAMEWORK_NAME} artifact publish "<name>" --json), after the user selects and confirms the commit and push, for a Delivery Group whose delivery branch is merged. It creates no tag. Never hand-commit or hand-tag one. Publish archives submitted changes and never submits: submitting is a precondition (mate-submit-change, before the merge).</rule>`,
    );
  }

  for (const type of context.artifactTypes ?? []) lines.push(artifactTypeRule(type));

  if (context.stages?.length) lines.push(stagesRule(context.stages));

  if (options.enteredWorktreeGit && hasRtkCapability(context.capabilities)) {
    lines.push(ENTERED_WORKTREE_GIT_RULE);
  }

  lines.push("  </mandatory-rules>");

  lines.push("</companion-policy>");

  return lines.join("\n");
}

/**
 * Build the merged single-string guidance: the companion-policy XML plus
 * codebase-exploration guidance appended when graphify or tokensave is
 * enabled. Used by providers (e.g. Claude) that inject one combined prompt
 * fragment rather than delivering exploration guidance separately; only that
 * form carries the Claude-only `entered-worktree-git` rule.
 */
export function buildCompanionGuidance(
  context: GuidanceContext,
  options: { wrapperBinPath: string },
): string {
  const lines = [buildCompanionPolicyXml(context, { ...options, enteredWorktreeGit: true })];

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
  options: {
    companionScoped?: boolean;
    secretGuardrails?: boolean;
    artifactTypes?: readonly GuidanceArtifactType[];
    stages?: readonly GuidanceStage[];
  } = {},
): MateGuidanceFile {
  const repository = options.companionScoped
    ? undefined
    : { id: "$MATE_REPO_ID", path: "$MATE_REPO_PATH" };
  const companionGuidance = buildCompanionPolicyXml(
    {
      companionPath: "$MATE_ARTIFACT_PATH",
      repository,
      capabilities,
      secretGuardrails: options.secretGuardrails,
      ...(options.artifactTypes ? { artifactTypes: options.artifactTypes } : {}),
      ...(options.stages ? { stages: options.stages } : {}),
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
