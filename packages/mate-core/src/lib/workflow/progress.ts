import { BUILTIN_BY_ID, type Workflow, type WorkflowStage } from "../../runtime/workflow/workflow";

/**
 * Where a change is on its companion's Delivery Path: its first stage that is neither optional
 * nor done. Imports nothing beyond the workflow model, so Studio places changes with it too.
 */

/** What a built-in-type change's plan and tasks say, which its built-in stages are inferred from. */
export interface PlanFacts {
  /** The change validates. */
  valid: boolean;
  totalTasks: number;
  completedTasks: number;
}

export interface ChangeFacts {
  /** Stage ids its Delivery Record holds as done. */
  recorded: readonly string[];
  state?: "active" | "submitted" | "dropped";
  /** Its Delivery Group could not publish. */
  blocked?: boolean;
  /** Absent for a change of a declared type, for which nothing is inferred. */
  plan?: PlanFacts;
}

/** A built-in stage is done by what the plan says, as before stages were recorded. */
function inferred(id: string, plan: PlanFacts): boolean {
  switch (id) {
    case "clarify-intent":
    case "explore":
      // The change exists, so it was explored.
      return true;
    case "propose":
      return plan.valid && plan.totalTasks > 0;
    case "apply":
      return plan.totalTasks > 0 && plan.completedTasks === plan.totalTasks;
    default:
      return false;
  }
}

function isDone(workflow: Workflow, index: number, facts: ChangeFacts): boolean {
  const stage = workflow.stages[index]!;
  if (facts.recorded.includes(stage.id)) return true;
  // Submit records nothing: the change's state says it.
  if (stage.id === "submit") return facts.state === "submitted";
  // Nothing is inferred for a declared type's change.
  const plan = workflow.submitArtifact === null ? facts.plan : undefined;
  if (stage.kind === "review") {
    // A review has no signal of its own: started work, or a later recorded stage, passes it.
    const later = workflow.stages.slice(index + 1).some((next) => facts.recorded.includes(next.id));
    return later || facts.state === "submitted" || (plan !== undefined && plan.completedTasks > 0);
  }
  return plan !== undefined && BUILTIN_BY_ID.has(stage.id) && inferred(stage.id, plan);
}

/**
 * The stage the change is at; null for a dropped change, which is at none. A submitted change is
 * at `publish`, blocked or not.
 */
export function changeStage(workflow: Workflow, facts: ChangeFacts): WorkflowStage | null {
  if (facts.state === "dropped") return null;
  const last = workflow.stages.at(-1) ?? null;
  if (facts.state === "submitted") return last;
  return (
    workflow.stages.find((stage, index) => !stage.optional && !isDone(workflow, index, facts)) ??
    last
  );
}
