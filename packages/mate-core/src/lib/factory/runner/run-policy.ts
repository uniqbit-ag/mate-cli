import type { RunStage, RunState } from "./state";

/** Shared run predicates; safe for the browser's Outcome policy. */
export function retryRefusal(id: string, state: RunState["state"]): string | null {
  return state === "failed" || state === "interrupted"
    ? null
    : `Workset ${id} has no failed or interrupted run to retry`;
}

export function runnableStage(stage: RunStage): Exclude<RunStage, "archive"> {
  return stage === "archive" ? "apply" : stage;
}
