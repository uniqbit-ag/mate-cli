/**
 * The Delivery Path stage contract: the action-named sequence Studio and the docs check
 * read. Review stages come from a schema's artifacts.
 */

/** A skill stage runs a Mate skill; a human stage is a person reviewing one artifact. */
export type DeliveryStageKind = "skill" | "human";

interface StageBase {
  /** Stable identifier, e.g. `archive` or `review-specs`. */
  id: string;
  /** The action the stage performs, e.g. `Archive change`. */
  label: string;
  kind: DeliveryStageKind;
  /** Optional stages can be skipped and never block a later stage. */
  optional: boolean;
}

export type SkillStageId =
  | "clarify-intent"
  | "explore"
  | "propose"
  | "apply"
  | "inspect-outcome"
  | "refine-code"
  | "archive"
  | "publish";

export interface SkillStage extends StageBase {
  id: SkillStageId;
  kind: "skill";
  /** The Mate skill that drives the stage. */
  skill: string;
}

export interface ReviewStage extends StageBase {
  kind: "human";
  skill: null;
  /** The schema artifact the person reviews. */
  artifact: string;
}

export type DeliveryStage = SkillStage | ReviewStage;

export interface DeliveryPath {
  stages: DeliveryStage[];
  /** False when the schema's artifacts could not be read, so reviews are unknown. */
  reviewsKnown: boolean;
}

/** Artifact sets of the schemas Mate ships, in dependency order. */
export const SCHEMA_ARTIFACTS = {
  "mate-v1": ["proposal", "specs", "design", "tasks"],
  "mate-minimal": ["specs", "tasks"],
} as const satisfies Record<string, readonly string[]>;

/** A schema Mate ships. */
export type MateSchema = keyof typeof SCHEMA_ARTIFACTS;

/** The schema every companion is set to. */
export const DEFAULT_SCHEMA: MateSchema = "mate-v1";

export function isMateSchema(schema: string): schema is MateSchema {
  return Object.hasOwn(SCHEMA_ARTIFACTS, schema);
}

function skillStage(id: SkillStageId, label: string, skill: string, optional = false): SkillStage {
  return { id, label, kind: "skill", skill, optional };
}

const BEFORE_REVIEWS: readonly SkillStage[] = [
  skillStage("clarify-intent", "Clarify intent", "mate-clarify-intent", true),
  skillStage("explore", "Explore change", "mate-explore-change"),
  skillStage("propose", "Propose change", "mate-propose-change"),
];

const AFTER_REVIEWS: readonly SkillStage[] = [
  skillStage("apply", "Apply change", "mate-apply-change"),
  skillStage("inspect-outcome", "Inspect outcome", "mate-show-me", true),
  skillStage("refine-code", "Refine code", "mate-simplify-code", true),
  skillStage("archive", "Archive change", "mate-archive-change"),
  skillStage("publish", "Publish companion artifacts", "mate-publish-artifact"),
];

/** Every skill a Delivery Path stage is driven by, in stage order. */
export const DELIVERY_STAGE_SKILLS: readonly string[] = [...BEFORE_REVIEWS, ...AFTER_REVIEWS].map(
  (stage) => stage.skill,
);

function reviewStage(artifact: string): ReviewStage {
  return {
    id: `review-${artifact}`,
    label: `Review ${artifact}`,
    kind: "human",
    skill: null,
    artifact,
    optional: false,
  };
}

/**
 * The Delivery Path for one schema. `artifacts` are its artifact ids in dependency order;
 * `undefined` means the schema could not be read, which yields the skill stages alone with
 * `reviewsKnown: false` rather than a guessed review set.
 */
export function deliveryPath(artifacts: readonly string[] | undefined): DeliveryPath {
  return {
    stages: [...BEFORE_REVIEWS, ...(artifacts ?? []).map(reviewStage), ...AFTER_REVIEWS],
    reviewsKnown: artifacts !== undefined,
  };
}
