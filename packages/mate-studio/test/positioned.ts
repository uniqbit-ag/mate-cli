import {
  defaultWorkflow,
  pathPosition,
  type StudioChange,
  type Workflow,
} from "@uniqbit/mate-core/studio";

/**
 * `change` with the position the payload gives it on `workflow`, from its validation, tasks and
 * recorded steps.
 */
export function positioned(
  change: StudioChange,
  workflow: Workflow = defaultWorkflow(),
): StudioChange {
  const progress = {
    steps: change.steps ?? {},
    ...(change.dropped ? { state: "dropped" as const } : {}),
    plan: {
      valid: change.valid !== false,
      totalTasks: change.totalTasks ?? 0,
      completedTasks: change.completedTasks ?? 0,
    },
  };
  return { ...change, position: pathPosition(workflow, progress, { name: change.name }) };
}
