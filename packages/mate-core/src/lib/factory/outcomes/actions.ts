import type { WorksetStageId } from "../../workset/stage";
import type { ControlMode, RunState } from "../runner/state";
import { retryRefusal } from "../runner/run-policy";

// Kept free of Node modules so Studio's board can read the same policy.

/** Every action a person can take on an Outcome. None sets a stage. */
export const OUTCOME_ACTIONS = [
  "start",
  "later",
  "answer",
  "take-control",
  "return",
  "retry",
  "cancel",
  "feedback",
  "regenerate",
  "start-apply",
  "publish",
] as const;

export type OutcomeAction = (typeof OUTCOME_ACTIONS)[number];

export function isOutcomeAction(value: unknown): value is OutcomeAction {
  return (OUTCOME_ACTIONS as readonly unknown[]).includes(value);
}

/** What the policy reads of a Workset card. */
export interface OutcomeFacts {
  id: string;
  stage: WorksetStageId;
  stageLabel: string;
}

/** What the policy reads of a Workset's run; absent while it never ran. */
export interface OutcomeRunFacts {
  state: RunState["state"];
  /** Set while a person has, or asked for, the conversation. */
  control?: { mode: ControlMode };
  /** The factory has a Claude session a person can take over. */
  conversation?: boolean;
}

/** What the policy reads of the companion's factory. */
export interface OutcomeCompanionFacts {
  /** The factory runs this companion's Outcomes; without it only Start and Later apply. */
  runner: boolean;
}

/** Why an action needing the AFK runner is refused for a companion the factory does not run. */
export const NO_RUNNER_REFUSAL =
  "the AFK runner needs the appliance's factory mode for this companion";

/**
 * Why the factory refuses `action` on this Outcome now, or `null` when it accepts it. Checks
 * the factory can only make at the time, such as a live terminal session, come on top.
 */
export function outcomeRefusal(
  action: OutcomeAction,
  workset: OutcomeFacts,
  run: OutcomeRunFacts | undefined,
  companion: OutcomeCompanionFacts,
): string | null {
  const { id, stage, stageLabel } = workset;
  const state = run?.state ?? "idle";
  if (action === "start") return stage === "done" ? `Workset ${id} is done` : null;
  if (action === "later") {
    if (stage === "done") return `Workset ${id} is done`;
    // Later only before work begins; a failed or interrupted clarify left nothing running.
    const begun = stage !== "clarify-intent" || state === "running" || state === "waiting";
    return begun
      ? `work on Workset ${id} has begun (${stageLabel}, ${state}); it can no longer move to Later`
      : null;
  }
  if (!companion.runner) return NO_RUNNER_REFUSAL;
  switch (action) {
    case "answer":
      return state === "waiting" ? null : "this question was already answered";
    case "take-control":
      if (!run?.conversation) return "this Outcome has no factory conversation to take over";
      if (run.control) return "a person already has, or asked for, this Outcome's conversation";
      return stage === "done" ? `Workset ${id} is done` : null;
    case "return":
      return run?.control && run.control.mode !== "automatic"
        ? null
        : "the factory already drives this Outcome";
    case "retry":
      return retryRefusal(id, state);
    case "cancel":
      return state === "queued" || state === "running"
        ? null
        : `Workset ${id} has no run to cancel`;
    case "feedback":
      return stage === "human-review" || stage === "apply" || stage === "merge-wait"
        ? null
        : `Workset ${id} takes no feedback at ${stageLabel}; start a new outcome instead`;
    case "regenerate":
    case "start-apply":
      return stage === "human-review"
        ? null
        : `Workset ${id} is not in the Human Reviews; it is at ${stageLabel}`;
    case "publish":
      return stage === "publish"
        ? null
        : `Workset ${id} is not merged and archived; it is at ${stageLabel}`;
  }
}

/** The actions the factory accepts on this Outcome now; the board offers no others. */
export function outcomeActions(
  workset: OutcomeFacts,
  run: OutcomeRunFacts | undefined,
  companion: OutcomeCompanionFacts,
): ReadonlySet<OutcomeAction> {
  return new Set(
    OUTCOME_ACTIONS.filter((action) => outcomeRefusal(action, workset, run, companion) === null),
  );
}
