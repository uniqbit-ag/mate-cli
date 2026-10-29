import {
  DEFAULT_SCHEMA,
  deliveryPath,
  isMateSchema,
  SCHEMA_ARTIFACTS,
  type DeliveryStage,
  type MateSchema,
  type SkillStageId,
} from "../../../../../lib/delivery/stages";
import { CHANGE_PLACEHOLDER, IDEA_PLACEHOLDER } from "../../selection";
import type { WorkflowTopology } from "../../topology";

export type WorkflowStepBadge = "optional" | "skill" | "openspec" | "human-review";

export type WorkflowPhaseId = "plan" | "review" | "build" | "ship";

export interface WorkflowAlternative {
  name: string;
  description: string;
  prompt: string;
  copyPrompt: string;
}

export type WorkflowStep = DeliveryStage & {
  /** The action the stage performs. */
  what: string;
  /** The reason the stage is in the sequence at this position. */
  why: string;
  badges: WorkflowStepBadge[];
  /** Null for a human review: a person performs it, so there is nothing to run. */
  prompt: string | null;
  copyPrompt: string | null;
  alternatives?: WorkflowAlternative[];
  /** The stage's skill when the companion does not report it. */
  missingSkill?: string;
  sessionBreakBefore?: boolean;
  phase: WorkflowPhaseId;
};

/** One step of the stage map: a single stage, or a run of review stages or optional peers. */
export type WorkflowMapNode =
  | { kind: "stage"; step: WorkflowStep }
  | { kind: "group"; group: "human" | "optional"; steps: WorkflowStep[] };

export interface WorkflowPath {
  schema: string;
  label: string;
  /** Short tab caption, e.g. `full planning`. */
  tagline: string;
  description: string;
  steps: WorkflowStep[];
  map: WorkflowMapNode[];
  reviewsKnown: boolean;
}

export interface WorkflowPlanOptions {
  /** Skills reported for the companion; undefined treats every stage skill as present. */
  skills?: readonly string[];
  topology?: WorkflowTopology | null;
}

export interface WorkflowPlan {
  paths: WorkflowPath[];
}

const CLARIFY_MODES = ["mate-clarify-intent", "mate-interview-me", "mate-grill-me"] as const;

const CLARIFY_DESCRIPTIONS: Record<(typeof CLARIFY_MODES)[number], string> = {
  "mate-clarify-intent":
    "Default. Reads what the request already states and routes to an interview, grilling, or skip, then runs that one mode.",
  "mate-interview-me":
    "Explicit mode: guided, one-question-at-a-time clarification when intent, constraints, or scope still need confirmation.",
  "mate-grill-me":
    "Explicit mode: round-based stress test of a mostly known direction to surface hidden assumptions and risks.",
};

const STAGE_TEXT: Record<SkillStageId, { what: string; why: string }> = {
  "clarify-intent": {
    what: "Settles who the change is for, why it is needed, how success is measured, and what binds it, before any artifact exists.",
    why: "Intent gaps are cheapest to close before exploration turns them into documents.",
  },
  explore: {
    what: "Resolves repository evidence, unknowns, and options, with scope taken from the companion context map, and suggests slicing a large feature.",
    why: "It separates uncertainty from the proposal's committed scope.",
  },
  propose: {
    what: "Chooses the schema from the minimal eligibility test, checks slicing when explore agreed none, and writes the change's planning artifacts in one prompt.",
    why: "One prompt writes every artifact; each one is then reviewed on its own.",
  },
  apply: {
    what: "Records the delivery branch, avoiding protected branches, then implements the reviewed tasks.",
    why: "The recorded branch is what archive and publication later wait on.",
  },
  "inspect-outcome": {
    what: "Shows what the applied change did as a rendered diagram and diff in a Mate report.",
    why: "Seeing the result tells the reviewer whether cleanup is warranted.",
  },
  "refine-code": {
    what: "Looks for smaller, clearer code once tests pass, preserving behavior.",
    why: "Cleanup lands before archive, so shipped code and recorded specs agree.",
  },
  archive: {
    what: "Applies the delta specs to the local canonical specs and records the delivery; allowed before the branch merges.",
    why: "A feature's later changes build on canonical specs that already include this one.",
  },
  publish: {
    what: "Commits, tags, and pushes archived changes whose delivery branches are merged, chosen by the developer.",
    why: "Published canonical specs then describe the default branch; unmerged archives wait.",
  },
};

function reviewText(
  artifact: string,
  topology: WorkflowTopology | null | undefined,
  schema: string,
) {
  const description =
    topology?.schemaName === schema
      ? topology.artifacts.find((entry) => entry.id === artifact)?.description
      : undefined;
  return {
    what: description ?? `A person reviews the ${artifact} artifact.`,
    why: "Reviews stay with people: Mate never marks them approved.",
  };
}

function promptFor(stage: DeliveryStage, schema: string): string | null {
  if (stage.kind === "human") return null;
  if (stage.id === "clarify-intent") return `/${stage.skill} about ${IDEA_PLACEHOLDER}`;
  const schemaNote =
    stage.id === "propose" && schema !== DEFAULT_SCHEMA ? ` (use schema: ${schema})` : "";
  return `/${stage.skill}${schemaNote} for ${CHANGE_PLACEHOLDER}`;
}

/** The prompt without its placeholders, ready to be completed after pasting. */
function copyPromptFor(prompt: string | null): string | null {
  if (!prompt) return prompt;
  return prompt.replace(` ${CHANGE_PLACEHOLDER}`, "").replace(` ${IDEA_PLACEHOLDER}`, "");
}

function clarifyAlternatives(available: (skill: string) => boolean): WorkflowAlternative[] {
  return CLARIFY_MODES.filter(available).map((name) => ({
    name,
    description: CLARIFY_DESCRIPTIONS[name],
    prompt: `/${name} about ${IDEA_PLACEHOLDER}`,
    copyPrompt: `/${name} about`,
  }));
}

/** Stages whose skills run an OpenSpec workflow. */
const OPENSPEC_STAGES: ReadonlySet<SkillStageId> = new Set([
  "explore",
  "propose",
  "apply",
  "archive",
]);

function badgesFor(stage: DeliveryStage): WorkflowStepBadge[] {
  if (stage.kind === "human") return ["human-review"];
  const badges: WorkflowStepBadge[] = stage.optional ? ["optional", "skill"] : ["skill"];
  if (OPENSPEC_STAGES.has(stage.id)) badges.push("openspec");
  return badges;
}

const SHIPPED_PATH_TEXT: Record<MateSchema, { tagline: string; description: string }> = {
  "mate-v1": {
    tagline: "full planning",
    description: "Full planning path: proposal, specs, design, and tasks.",
  },
  "mate-minimal": {
    tagline: "minimal planning",
    description:
      "Short path: specs and tasks only, for one-Area, low-risk changes with clear intent.",
  },
};

function pathText(schema: string): { tagline: string; description: string } {
  if (isMateSchema(schema)) return SHIPPED_PATH_TEXT[schema];
  return { tagline: "custom schema", description: `Planning path of the ${schema} schema.` };
}

export const PHASE_LABELS: Record<WorkflowPhaseId, string> = {
  plan: "Plan",
  review: "Review",
  build: "Build",
  ship: "Ship",
};

/** Plan precedes reviews, Review holds them, Build is apply plus its optional peers, Ship follows. */
function phaseOf(stage: DeliveryStage, previous: WorkflowPhaseId | undefined): WorkflowPhaseId {
  if (stage.kind === "human") return "review";
  if (stage.id === "apply") return "build";
  if (previous === "build" && stage.optional) return "build";
  return previous === undefined || previous === "plan" ? "plan" : "ship";
}

function groupOf(step: WorkflowStep): "human" | "optional" | null {
  if (step.kind === "human") return "human";
  return step.optional ? "optional" : null;
}

/** Review runs are always one group; optional runs group only when they hold peers. */
function mapOf(steps: readonly WorkflowStep[]): WorkflowMapNode[] {
  const runs: { group: "human" | "optional" | null; steps: WorkflowStep[] }[] = [];
  for (const step of steps) {
    const group = groupOf(step);
    const run = runs.at(-1);
    if (group && run?.group === group) run.steps.push(step);
    else runs.push({ group, steps: [step] });
  }
  return runs.map((run) =>
    run.group === "human" || (run.group === "optional" && run.steps.length > 1)
      ? { kind: "group", group: run.group, steps: run.steps }
      : { kind: "stage", step: run.steps[0] },
  );
}

export function buildPath(
  schema: string,
  artifacts: readonly string[] | undefined,
  options: WorkflowPlanOptions,
): WorkflowPath {
  const reported = options.skills ? new Set(options.skills) : null;
  const available = (skill: string): boolean => !reported || reported.has(skill);
  const contract = deliveryPath(artifacts);

  const steps: WorkflowStep[] = [];
  for (const stage of contract.stages) {
    const text =
      stage.kind === "human"
        ? reviewText(stage.artifact, options.topology, schema)
        : STAGE_TEXT[stage.id];
    const prompt = promptFor(stage, schema);
    const previous = steps.at(-1);
    const step: WorkflowStep = {
      ...stage,
      what: text.what,
      why: text.why,
      badges: badgesFor(stage),
      prompt,
      copyPrompt: copyPromptFor(prompt),
      phase: phaseOf(stage, previous?.phase),
    };
    if (stage.id === "clarify-intent") step.alternatives = clarifyAlternatives(available);
    if (stage.kind === "skill" && !available(stage.skill)) step.missingSkill = stage.skill;
    // A new session starts at apply; the optional peers after it reuse its context.
    if (stage.id === "apply") step.sessionBreakBefore = true;
    steps.push(step);
  }

  return {
    schema,
    label: schema,
    ...pathText(schema),
    steps,
    map: mapOf(steps),
    reviewsKnown: contract.reviewsKnown,
  };
}

function schemaArtifacts(
  schema: string,
  topology: WorkflowTopology | null | undefined,
): readonly string[] | undefined {
  if (topology?.schemaName === schema) return topology.artifacts.map((artifact) => artifact.id);
  return isMateSchema(schema) ? SCHEMA_ARTIFACTS[schema] : undefined;
}

/** The Delivery Path Studio shows: a path per schema Mate ships, or the served schema's alone. */
export function workflowPlan(options: WorkflowPlanOptions = {}): WorkflowPlan {
  const served = options.topology?.schemaName;
  const schemas = served && !isMateSchema(served) ? [served] : Object.keys(SCHEMA_ARTIFACTS);
  return {
    paths: schemas.map((schema) =>
      buildPath(schema, schemaArtifacts(schema, options.topology), options),
    ),
  };
}
