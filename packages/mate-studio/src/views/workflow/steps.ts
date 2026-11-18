import {
  CHANGE_PLACEHOLDER,
  DEFAULT_SCHEMA,
  defaultWorkflow,
  deliveryPath,
  IDEA_PLACEHOLDER,
  isMateSchema,
  SCHEMA_ARTIFACTS,
  WORKFLOW_FILE,
  type DeliveryStage,
  type MateSchema,
  type SkillStage,
  type SkillStageId,
  type Workflow,
  type WorkflowTopology,
} from "@uniqbit/mate-core/studio";

const DEFAULT_WORKFLOW = defaultWorkflow();

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

/** One step of the stage map: a single stage, one review stage's reviews, or optional peers. */
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
  /** False when the declaration is invalid: the default path is drawn without step lists. */
  stepsKnown: boolean;
}

export interface WorkflowPlanOptions {
  /** Skills reported for the companion; undefined treats every stage skill as present. */
  skills?: readonly string[];
  topology?: WorkflowTopology | null;
  /**
   * The companion's resolved workflow; undefined is the built-in default, null an invalid
   * declaration.
   */
  workflow?: Workflow | null;
}

/** The graph node of a review stage: `reviews` for the default one. */
export function reviewNode(group: string): string {
  return group === "review" ? "reviews" : `reviews-${group}`;
}

/** The graph node a stage of the path is drawn in. */
export function nodeOf(step: DeliveryStage): string {
  return step.kind === "human" ? reviewNode(step.group) : step.id;
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
    why: "The recorded branch is what submit and publication later wait on.",
  },
  "inspect-outcome": {
    what: "Shows what the applied change did as a rendered diagram and diff in a Mate report.",
    why: "Seeing the result tells the reviewer whether cleanup is warranted.",
  },
  "refine-code": {
    what: "Looks for smaller, clearer code once tests pass, preserving behavior.",
    why: "Cleanup lands before submit, so shipped code and recorded specs agree.",
  },
  submit: {
    what: "Records the delivery, validates the change, and pushes its Delivery Group's change folders for publication; allowed before the branch merges.",
    why: "The finished change is safe on the remote and publishable from any machine once merged.",
  },
  publish: {
    what: "Archives submitted Delivery Groups whose delivery branches are merged, from any machine, and commits and pushes them, chosen by the developer.",
    why: "Published canonical specs then describe the default branch; unmerged changes wait.",
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

/** What the panel says about a stage the companion added. */
function declaredText(stage: SkillStage): { what: string; why: string } {
  return {
    what: `Runs ${stage.steps.map((step) => step.skill).join(", then ")}.`,
    why: `The companion declares this stage in ${WORKFLOW_FILE}.`,
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

/** Mate stage skills that run an OpenSpec workflow. */
const OPENSPEC_SKILLS: ReadonlySet<string> = new Set([
  "mate-explore-change",
  "mate-propose-change",
  "mate-apply-change",
]);

/** A stage runs OpenSpec while its chain holds such a skill, or submits the built-in type. */
function runsOpenSpec(stage: SkillStage, workflow: Workflow): boolean {
  if (stage.id === "submit") return workflow.submitArtifact === null;
  return stage.steps.some((step) => OPENSPEC_SKILLS.has(step.skill));
}

function badgesFor(stage: DeliveryStage, workflow: Workflow): WorkflowStepBadge[] {
  if (stage.kind === "human") return ["human-review"];
  const badges: WorkflowStepBadge[] = stage.optional ? ["optional", "skill"] : ["skill"];
  if (runsOpenSpec(stage, workflow)) badges.push("openspec");
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

const SHIP_STAGES: ReadonlySet<string> = new Set(["submit", "publish"]);

/**
 * Phases follow position: Plan before the last review, Review the reviews, Build from the
 * first skill stage after the last review to the stage before `submit`, Ship `submit` and
 * `publish`. A path without reviews builds from `apply`.
 */
function phasesOf(stages: readonly DeliveryStage[]): WorkflowPhaseId[] {
  const lastReview = stages.findLastIndex((stage) => stage.kind === "human");
  const buildFrom =
    lastReview === -1 ? stages.findIndex((stage) => stage.id === "apply") : lastReview + 1;
  return stages.map((stage, index) => {
    if (stage.kind === "human") return "review";
    if (SHIP_STAGES.has(stage.id)) return "ship";
    return buildFrom !== -1 && index >= buildFrom ? "build" : "plan";
  });
}

/** The run a step joins: its review stage, or the optional peers around it. */
function groupOf(step: WorkflowStep): string | null {
  if (step.kind === "human") return `human:${step.group}`;
  return step.optional ? "optional" : null;
}

/** A review stage is always one group; optional runs group only when they hold peers. */
function mapOf(steps: readonly WorkflowStep[]): WorkflowMapNode[] {
  const runs: { group: "human" | "optional" | null; key: string | null; steps: WorkflowStep[] }[] =
    [];
  for (const step of steps) {
    const key = groupOf(step);
    const run = runs.at(-1);
    if (key && run?.key === key) run.steps.push(step);
    else
      runs.push({
        group: step.kind === "human" ? "human" : key ? "optional" : null,
        key,
        steps: [step],
      });
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
  const workflow = options.workflow ?? DEFAULT_WORKFLOW;
  const contract = deliveryPath(artifacts, workflow);
  const phases = phasesOf(contract.stages);

  const steps: WorkflowStep[] = contract.stages.map((stage, index) => {
    const text =
      stage.kind === "human"
        ? reviewText(stage.artifact, options.topology, schema)
        : // A stage keeps its text while its chain holds its Mate stage skill; any other names its steps.
          stage.steps.some((entry) => entry.own) && stage.id in STAGE_TEXT
          ? STAGE_TEXT[stage.id as SkillStageId]
          : declaredText(stage);
    const prompt = promptFor(stage, schema);
    const step: WorkflowStep = {
      ...stage,
      what: text.what,
      why: text.why,
      badges: badgesFor(stage, workflow),
      prompt,
      copyPrompt: copyPromptFor(prompt),
      phase: phases[index]!,
    };
    // The clarify modes are alternatives to the Mate skill, not to a declared chain.
    if (stage.id === "clarify-intent" && stage.skill === CLARIFY_MODES[0]) {
      step.alternatives = clarifyAlternatives(available);
    }
    if (stage.kind === "skill") {
      const missing = [stage.skill, ...stage.steps.map((entry) => entry.skill)].find(
        (skill) => !available(skill),
      );
      if (missing) step.missingSkill = missing;
    }
    // A new session starts at apply; the optional peers after it reuse its context.
    if (stage.id === "apply") step.sessionBreakBefore = true;
    return step;
  });

  return {
    schema,
    label: schema,
    ...pathText(schema),
    steps,
    map: mapOf(steps),
    reviewsKnown: contract.reviewsKnown,
    stepsKnown: options.workflow !== null,
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
