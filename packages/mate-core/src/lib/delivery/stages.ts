import {
  BUILTIN_STAGES,
  defaultWorkflow,
  reviewableArtifacts,
  reviewedArtifacts,
  type BuiltinStageId,
  type Workflow,
  type WorkflowReviewStage,
  type WorkflowSource,
  type WorkflowStep,
} from "../../runtime/workflow/workflow";

/**
 * The Delivery Path stage contract: the action-named sequence Studio and the docs check
 * read, computed from the companion's workflow. Review stages come from a schema's artifacts.
 */

/** A skill stage runs its steps; a human stage is a person reviewing one artifact. */
export type DeliveryStageKind = "skill" | "human";

interface StageBase {
  /** Stable identifier, e.g. `submit` or `review-specs`. */
  id: string;
  /** The action the stage performs, e.g. `Submit change`. */
  label: string;
  kind: DeliveryStageKind;
  /** Optional stages can be skipped and never block a later stage. */
  optional: boolean;
}

/** A built-in skill stage id; a declared path may hold any other id. */
export type SkillStageId = BuiltinStageId;

export interface SkillStage extends StageBase {
  kind: "skill";
  /** The skill the stage is started with: its first step's. */
  skill: string;
  /** The stage's chain, in order. */
  steps: WorkflowStep[];
  /** Whether the companion declared the chain or it is the built-in default. */
  source: WorkflowSource;
}

export interface ReviewStage extends StageBase {
  kind: "human";
  skill: null;
  /** The artifact the person reviews. */
  artifact: string;
  /** Id of the review stage it belongs to. */
  group: string;
  /** That review stage's label, e.g. `Human review`. */
  groupLabel: string;
}

export type DeliveryStage = SkillStage | ReviewStage;

export interface DeliveryPath {
  stages: DeliveryStage[];
  /** False when the schema's artifacts could not be read, so reviews are unknown. */
  reviewsKnown: boolean;
}

const FULL_ARTIFACTS = ["proposal", "specs", "design", "tasks"] as const;

/**
 * Artifact sets of the schemas Mate ships, in dependency order, keyed by every name
 * Mate recognizes, legacy aliases included.
 */
export const SCHEMA_ARTIFACTS = {
  "mate-full": FULL_ARTIFACTS,
  "mate-minimal": ["specs", "tasks"],
  "mate-v1": FULL_ARTIFACTS,
} as const satisfies Record<string, readonly string[]>;

/** A schema name Mate recognizes, legacy aliases included. */
export type MateSchema = keyof typeof SCHEMA_ARTIFACTS;

/** Earlier schema names, each mapped to the schema it now names. */
export const LEGACY_SCHEMA_ALIASES = {
  "mate-v1": "mate-full",
} as const satisfies Partial<Record<MateSchema, MateSchema>>;

/** The schemas Mate ships, one entry each: what to list or show. */
export const SHIPPED_SCHEMAS = ["mate-full", "mate-minimal"] as const satisfies readonly Exclude<
  MateSchema,
  keyof typeof LEGACY_SCHEMA_ALIASES
>[];

/** The schema setup makes a new companion's default. */
export const DEFAULT_SCHEMA: (typeof SHIPPED_SCHEMAS)[number] = "mate-full";

export function isMateSchema(schema: string): schema is MateSchema {
  return Object.hasOwn(SCHEMA_ARTIFACTS, schema);
}

/** The Mate stage skills, in default stage order. */
export const DELIVERY_STAGE_SKILLS: readonly string[] = BUILTIN_STAGES.map((stage) => stage.skill);

/** The current name for `schema`: a legacy alias maps to its schema, any other name stays. */
export function canonicalSchema(schema: string): string {
  return Object.hasOwn(LEGACY_SCHEMA_ALIASES, schema)
    ? LEGACY_SCHEMA_ALIASES[schema as keyof typeof LEGACY_SCHEMA_ALIASES]
    : schema;
}

const DEFAULT_WORKFLOW = defaultWorkflow();

function reviewStage(artifact: string, stage: WorkflowReviewStage): ReviewStage {
  return {
    id: `review-${artifact}`,
    label: `Review ${artifact}`,
    kind: "human",
    skill: null,
    artifact,
    group: stage.id,
    groupLabel: stage.label,
    optional: stage.optional,
  };
}

/**
 * The Delivery Path of `workflow` for one change. `artifacts` are the artifact ids of the
 * change's schema in dependency order; `undefined` means the schema could not be read, which
 * yields the skill stages alone with `reviewsKnown: false` rather than a guessed review set.
 * A path whose submit handles a declared type reviews that type's artifacts instead.
 */
export function deliveryPath(
  artifacts: readonly string[] | undefined,
  workflow: Workflow = DEFAULT_WORKFLOW,
): DeliveryPath {
  const available = reviewableArtifacts(workflow, artifacts);
  return {
    stages: workflow.stages.flatMap((stage): DeliveryStage[] => {
      if (stage.kind === "review") {
        return reviewedArtifacts(stage, available ?? []).map((artifact) =>
          reviewStage(artifact, stage),
        );
      }
      const { id, label, optional, steps, source } = stage;
      return [{ id, label, kind: "skill", skill: stage.entry, optional, steps, source }];
    }),
    reviewsKnown: available !== undefined,
  };
}
