import { deliveryPath, type SkillStageId } from "../delivery/stages";
import type { LinkedChange, WorksetRecord } from "./record";

/**
 * A Workset's stage, derived rather than stored once a change is linked, so the
 * board cannot drift from OpenSpec and the Delivery Records. The Human Reviews
 * are one stage here: the schema records no approval, so the board cannot tell
 * one review from the next.
 */

export type WorksetStageId =
  | "clarify-intent"
  | "explore"
  | "propose"
  | "human-review"
  | "apply"
  | "merge-wait"
  | "publish"
  | "done";

/** Delivery Path order; a Workset sits at the earliest stage among its changes. */
export const WORKSET_STAGE_ORDER: readonly WorksetStageId[] = [
  "clarify-intent",
  "explore",
  "propose",
  "human-review",
  "apply",
  "merge-wait",
  "publish",
  "done",
];

/** Stages where a person acts: the conversational stages, the reviews, and the merge. */
export const HUMAN_TURN_STAGES: ReadonlySet<WorksetStageId> = new Set([
  "clarify-intent",
  "explore",
  "human-review",
  "merge-wait",
]);

export type WorksetTurn = "human" | "agent" | "none";

/** What one linked change's recorded state says. */
export interface ChangeFacts {
  name: string;
  archived: boolean;
  /** Every planning artifact of the change's schema is done. */
  artifactsComplete: boolean;
  /** The schema's artifacts, in review order; names the Human Reviews. */
  reviewArtifacts: string[];
  checkedTasks: number;
  /** The Delivery Record is merged, not applicable, or legacy: the Publication Merge Gate is open. */
  mergeSettled: boolean;
  /** The archive is committed to the companion: published. */
  published: boolean;
}

export function changeStage(facts: ChangeFacts): WorksetStageId {
  if (!facts.archived) {
    if (!facts.artifactsComplete) return "propose";
    return facts.checkedTasks === 0 ? "human-review" : "apply";
  }
  if (facts.published) return "done";
  return facts.mergeSettled ? "publish" : "merge-wait";
}

export interface DerivedWorksetStage {
  stage: WorksetStageId;
  label: string;
  turn: WorksetTurn;
  /** Linked changes that are missing or claimed twice, by name with the reason. */
  problems: string[];
}

const SKILL_LABELS = new Map(
  deliveryPath([]).stages.map((stage) => [stage.id as SkillStageId, stage.label]),
);

function labelOf(stage: WorksetStageId, reviewArtifacts: string[]): string {
  switch (stage) {
    case "human-review":
      return reviewArtifacts.length > 0 ? `Review ${reviewArtifacts.join(", ")}` : "Human Reviews";
    case "merge-wait":
      return "Waiting for merge";
    case "done":
      return "Done";
    default:
      return SKILL_LABELS.get(stage) ?? stage;
  }
}

function turnOf(stage: WorksetStageId): WorksetTurn {
  if (stage === "done") return "none";
  return HUMAN_TURN_STAGES.has(stage) ? "human" : "agent";
}

const PRE_PROPOSE: Record<WorksetRecord["stage"], WorksetStageId> = {
  "clarify-intent": "clarify-intent",
  explore: "explore",
  ready: "propose",
};

/**
 * The record's own stage while no change is linked; afterwards the earliest stage of its
 * resolvable changes. Missing and doubly claimed changes become problems and count for none.
 */
export function deriveWorksetStage(
  record: WorksetRecord,
  linked: LinkedChange[],
  factsOf: (name: string) => ChangeFacts | undefined,
): DerivedWorksetStage {
  const problems = linked.flatMap((change) => {
    if (change.kind === "missing") return [`${change.name} is neither active nor archived`];
    if (change.kind === "conflict") {
      return [
        `${change.name} is also listed by ${change.worksets.filter((id) => id !== record.id).join(", ")}`,
      ];
    }
    return [];
  });

  if (record.changes.length === 0) {
    const stage = PRE_PROPOSE[record.stage];
    return { stage, label: labelOf(stage, []), turn: turnOf(stage), problems };
  }

  const facts = linked.flatMap((change) => {
    if (change.kind !== "active" && change.kind !== "archived") return [];
    const entry = factsOf(change.name);
    return entry ? [entry] : [];
  });
  // Every linked change unusable: nothing to derive from, so propose is what is still owed.
  if (facts.length === 0) {
    return { stage: "propose", label: labelOf("propose", []), turn: "agent", problems };
  }

  let earliest = facts[0]!;
  for (const entry of facts) {
    if (
      WORKSET_STAGE_ORDER.indexOf(changeStage(entry)) <
      WORKSET_STAGE_ORDER.indexOf(changeStage(earliest))
    ) {
      earliest = entry;
    }
  }
  const stage = changeStage(earliest);
  return { stage, label: labelOf(stage, earliest.reviewArtifacts), turn: turnOf(stage), problems };
}
