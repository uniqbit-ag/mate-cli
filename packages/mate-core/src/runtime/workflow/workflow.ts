/**
 * A companion's workflow: the Delivery Path's stages with the skills each runs, and the artifact
 * types submit and publication handle. Imports nothing, so Studio's browser bundle can use it;
 * `declaration.ts` reads the file.
 */

/** Companion-relative path of the declaration. */
export const WORKFLOW_FILE = ".mate/config/workflow.yaml";

/** The declaration format this Mate reads. */
export const WORKFLOW_VERSION = 1;

/** Name of the built-in artifact type, never declared. */
export const BUILTIN_ARTIFACT_TYPE = "openspec";

export type BuiltinStageId =
  | "clarify-intent"
  | "explore"
  | "propose"
  | "apply"
  | "inspect-outcome"
  | "refine-code"
  | "submit"
  | "publish";

/**
 * A point in a piece of work's life a stage reaches. Read from the work's plan and state, never
 * recorded; a stage's tracking on the Path Position follows from it.
 */
export type Milestone = "exists" | "planned" | "implemented" | "submitted" | "published";

interface BuiltinStage {
  id: BuiltinStageId;
  label: string;
  /** The Mate stage skill, allowed in this stage only. */
  skill: string;
  optional: boolean;
  milestone?: Milestone;
}

const builtin = (
  id: BuiltinStageId,
  label: string,
  skill: string,
  optional: boolean,
  milestone?: Milestone,
): BuiltinStage => ({
  id,
  label,
  skill,
  optional,
  ...(milestone ? { milestone } : {}),
});

/** The built-in skill stages in default order, each with its Mate stage skill and Milestone. */
export const BUILTIN_STAGES: readonly BuiltinStage[] = [
  builtin("clarify-intent", "Clarify intent", "mate-clarify-intent", true),
  builtin("explore", "Explore change", "mate-explore-change", false, "exists"),
  builtin("propose", "Propose change", "mate-propose-change", false, "planned"),
  builtin("apply", "Apply change", "mate-apply-change", false, "implemented"),
  builtin("inspect-outcome", "Inspect outcome", "mate-show-me", true),
  builtin("refine-code", "Refine code", "mate-simplify-code", true),
  builtin("submit", "Submit change", "mate-submit-change", false, "submitted"),
  builtin("publish", "Publish companion artifacts", "mate-publish-artifact", false, "published"),
];

/** Id of the default review stage, which the default path places after `propose`. */
export const DEFAULT_REVIEW_STAGE = "review";

const DEFAULT_REVIEW_AFTER: BuiltinStageId = "propose";

export const BUILTIN_BY_ID = new Map<string, BuiltinStage>(
  BUILTIN_STAGES.map((stage) => [stage.id, stage]),
);
export const BUILTIN_BY_SKILL = new Map(BUILTIN_STAGES.map((stage) => [stage.skill, stage]));

/** The Mate stage skill of a built-in stage id; undefined for a custom id. */
export function mateStageSkill(stage: string): string | undefined {
  return BUILTIN_BY_ID.get(stage)?.skill;
}

export type WorkflowSource = "declared" | "default";

/** One item of a stage's chain. `own` marks the stage's Mate stage skill. */
export interface WorkflowStep {
  skill: string;
  own?: true;
}

interface StageBase {
  id: string;
  label: string;
  optional: boolean;
  source: WorkflowSource;
}

export interface WorkflowSkillStage extends StageBase {
  kind: "skill";
  steps: WorkflowStep[];
  /** The skill the stage is started with: its first step's. */
  entry: string;
  /** The Milestone of a stage with a built-in id; absent for a custom stage. */
  milestone?: Milestone;
}

export interface WorkflowReviewStage extends StageBase {
  kind: "review";
  /** `schema` for every reviewable artifact, else the artifact ids in review order. */
  review: "schema" | string[];
}

export type WorkflowStage = WorkflowSkillStage | WorkflowReviewStage;

/** A hook of a declared artifact type: code Mate ships, or a command run with `sh -c`. */
export type WorkflowHook = { builtin: string } | { run: string };

export interface WorkflowReview {
  id: string;
  /** Path relative to the change folder. */
  file: string;
}

export interface DeclaredArtifactType {
  name: string;
  /** Folder template of an active or submitted change, holding `{name}`. */
  change: string;
  /** Path globs of the files publication writes and agents read as current. */
  published: string[];
  /** Folder template of a published change kept as history, holding `{id}`. */
  archive?: string;
  /** The artifacts a review stage can name, in review order. */
  reviews: WorkflowReview[];
  hooks: { check?: WorkflowHook; apply: WorkflowHook; validate?: WorkflowHook };
}

/** The resolved workflow of one companion. */
export interface Workflow {
  /** Companion-relative path of the declaration; null when the companion has none. */
  file: string | null;
  stages: WorkflowStage[];
  artifacts: DeclaredArtifactType[];
  /** The type submit handles: a declared one or {@link BUILTIN_ARTIFACT_TYPE}. */
  submitArtifact: string;
  warnings: string[];
}

/** A problem of the declaration at a key path such as `stages[3].steps[1].skill`. */
export interface WorkflowProblem {
  path: string;
  message: string;
}

export type WorkflowVerdict =
  | { ok: true; workflow: Workflow }
  | { ok: false; file: string; problems: WorkflowProblem[] };

export function skillStageOf(
  id: string,
  label: string,
  optional: boolean,
  skills: readonly string[],
  source: WorkflowSource,
): WorkflowSkillStage {
  const known = BUILTIN_BY_ID.get(id);
  const steps = skills.map((skill): WorkflowStep =>
    skill === known?.skill ? { skill, own: true } : { skill },
  );
  const milestone = known?.milestone;
  return {
    id,
    label,
    kind: "skill",
    optional,
    source,
    steps,
    entry: skills[0] ?? "",
    ...(milestone ? { milestone } : {}),
  };
}

export function defaultStages(): WorkflowStage[] {
  return BUILTIN_STAGES.flatMap((stage): WorkflowStage[] => {
    const skill = skillStageOf(stage.id, stage.label, stage.optional, [stage.skill], "default");
    if (stage.id !== DEFAULT_REVIEW_AFTER) return [skill];
    return [
      skill,
      {
        id: DEFAULT_REVIEW_STAGE,
        label: "Human review",
        kind: "review",
        optional: false,
        source: "default",
        review: "schema",
      },
    ];
  });
}

/** The workflow of a companion without a declaration. */
export function defaultWorkflow(): Workflow {
  return {
    file: null,
    stages: defaultStages(),
    artifacts: [],
    submitArtifact: BUILTIN_ARTIFACT_TYPE,
    warnings: [],
  };
}

/** The declared type submit handles; undefined for the built-in type. */
export function submitType(workflow: Workflow): DeclaredArtifactType | undefined {
  return workflow.artifacts.find((type) => type.name === workflow.submitArtifact);
}

/**
 * The artifacts a review stage can name for a change: the declared type's `reviews` when submit
 * handles one, else `schemaArtifacts`, the planning artifacts of the change's own schema.
 */
export function reviewableArtifacts(
  workflow: Workflow,
  schemaArtifacts: readonly string[] | undefined,
): readonly string[] | undefined {
  return submitType(workflow)?.reviews.map((review) => review.id) ?? schemaArtifacts;
}

/** The artifacts `stage` reviews among `available`, skipping those the change lacks. */
export function reviewedArtifacts(
  stage: WorkflowReviewStage,
  available: readonly string[],
): string[] {
  if (stage.review === "schema") return [...available];
  return stage.review.filter((artifact) => available.includes(artifact));
}

/** What a stage hands off to: the next stage that is not optional, with those skipped on the way. */
export interface NextStage {
  id: string;
  kind: WorkflowStage["kind"];
  /** The skill a skill stage is started with. */
  entry?: string;
  /** What a review stage reviews. */
  review?: "schema" | string[];
  /** Optional skill stages before it, each with its entry. */
  optional: Array<{ id: string; entry: string }>;
}

/** The stage after `id` on the declared path; null after the last one. */
export function nextStage(workflow: Workflow, id: string): NextStage | null {
  const index = workflow.stages.findIndex((stage) => stage.id === id);
  if (index < 0) return null;
  const optional: NextStage["optional"] = [];
  for (const stage of workflow.stages.slice(index + 1)) {
    if (stage.optional) {
      if (stage.kind === "skill") optional.push({ id: stage.id, entry: stage.entry });
      continue;
    }
    return stage.kind === "skill"
      ? { id: stage.id, kind: stage.kind, entry: stage.entry, optional }
      : { id: stage.id, kind: stage.kind, review: stage.review, optional };
  }
  return null;
}
