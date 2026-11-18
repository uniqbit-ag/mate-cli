import {
  changeStage,
  defaultWorkflow,
  nextStage,
  type StudioChange,
  type StudioSubmittedChange,
  type Workflow,
  type WorkflowSkillStage,
  type WorkflowStage,
} from "@uniqbit/mate-core/studio";

/** What a change needs next, read from its validation and task counts (design D5). */
export type ChangeGroup = "needs-you" | "building" | "ready";

export const CHANGE_GROUPS: readonly ChangeGroup[] = ["needs-you", "building", "ready"];

export const GROUP_TITLES: Record<ChangeGroup, string> = {
  "needs-you": "Needs you",
  building: "Implementation started",
  ready: "Ready to submit",
};

export function changeGroup(change: StudioChange): ChangeGroup {
  const total = change.totalTasks ?? 0;
  const done = change.completedTasks ?? 0;
  if (change.valid === false || total === 0 || done === 0) return "needs-you";
  return done < total ? "building" : "ready";
}

/**
 * The changes still in flight: a submitted change awaits publication even when its folder is
 * checked out, unless that folder holds work the submitted one lacks.
 */
export function activeChanges(
  changes: StudioChange[],
  submitted: readonly StudioSubmittedChange[],
): StudioChange[] {
  const awaiting = new Set(submitted.map((change) => change.name));
  return changes.filter((change) => !awaiting.has(change.name) || change.unsubmitted === true);
}

export function groupChanges(changes: StudioChange[]): Record<ChangeGroup, StudioChange[]> {
  const groups: Record<ChangeGroup, StudioChange[]> = { "needs-you": [], building: [], ready: [] };
  for (const change of changes) groups[changeGroup(change)].push(change);
  return groups;
}

export interface ChangeStep {
  /** The Delivery Path stage the change is at. */
  stage: string;
  /** Id of that stage in the companion's workflow; null for a change at no stage. */
  stageId: string | null;
  /** True when a person reviews at this stage. */
  review: boolean;
  /** One line on where it is. */
  situation: string;
  /** What the person does next, and the prompt that does it. */
  next: string;
  prompt: string;
}

const DEFAULT_WORKFLOW = defaultWorkflow();

/** The prompt that starts a skill stage for a change: its first step's skill. */
export function stagePrompt(stage: WorkflowSkillStage, change: string): string {
  return `/${stage.entry} ${change}`;
}

/** Stages a change of the built-in type has always passed once it exists. */
const BEFORE_A_CHANGE: ReadonlySet<string> = new Set(["clarify-intent", "explore"]);

/** The stages a change walks: the required ones up to submit, as its panel lists them. */
export function changePath(workflow: Workflow = DEFAULT_WORKFLOW): WorkflowStage[] {
  return workflow.stages.filter(
    (stage) =>
      !stage.optional &&
      stage.id !== "publish" &&
      !(workflow.submitArtifact === null && BEFORE_A_CHANGE.has(stage.id)),
  );
}

/**
 * Where the change is on the companion's Delivery Path and what comes next. Recorded stages
 * count as done; the built-in stages of a change are inferred from its validation and tasks.
 */
export function changeStep(
  change: StudioChange,
  workflow: Workflow = DEFAULT_WORKFLOW,
): ChangeStep {
  const total = change.totalTasks ?? 0;
  const done = change.completedTasks ?? 0;
  const stage = changeStage(workflow, {
    recorded: change.stagesDone ?? [],
    ...(change.dropped ? { state: "dropped" as const } : {}),
    plan: { valid: change.valid !== false, totalTasks: total, completedTasks: done },
  });
  if (!stage) {
    return {
      stage: "Dropped",
      stageId: null,
      review: false,
      situation: "Withdrawn",
      next: "Nothing to do",
      prompt: "",
    };
  }
  const at = { stage: stage.label, stageId: stage.id };
  if (stage.kind === "review") {
    const next = nextStage(workflow, stage.id);
    const follows = workflow.stages.find((entry) => entry.id === next?.id);
    return {
      ...at,
      review: true,
      situation: "Plan ready for review",
      next:
        follows?.id === "apply"
          ? "Review the plan, then apply it"
          : `Review the plan, then run ${follows?.label ?? "the next stage"}`,
      prompt: follows?.kind === "skill" ? stagePrompt(follows, change.name) : "",
    };
  }
  const step = { ...at, review: false, prompt: stagePrompt(stage, change.name) };
  if (stage.id === "propose" && change.valid === false) {
    const issues = change.issueCount ?? 0;
    return {
      ...step,
      situation: `${issues} validation ${issues === 1 ? "issue" : "issues"}`,
      next: "Fix the plan so it validates",
    };
  }
  if (stage.id === "propose") {
    return { ...step, situation: "No tasks yet", next: "Finish the plan" };
  }
  if (stage.id === "apply" && done < total) {
    return {
      ...step,
      situation: `${total - done} ${total - done === 1 ? "task" : "tasks"} left`,
      next: "Continue the build",
    };
  }
  if (stage.id === "submit") {
    return { ...step, situation: "All tasks done", next: "Submit the change" };
  }
  return { ...step, situation: `${stage.label} is not done yet`, next: `Run ${stage.label}` };
}

export interface ChangeProgress {
  done: number;
  total: number;
  /** What `done` and `total` count. */
  unit: "tasks" | "artifacts";
}

/**
 * How far the change's stage is: the plan's artifacts while it is still being written, tasks
 * once the plan is complete and tasks are listed (so the bar never falls back at apply), and
 * tasks when no artifact is known.
 */
export function changeProgress(change: StudioChange): ChangeProgress {
  const tasks = { done: change.completedTasks ?? 0, total: change.totalTasks ?? 0 };
  if (tasks.done > 0 || change.artifacts.length === 0) return { ...tasks, unit: "tasks" };
  const done = change.artifacts.filter((artifact) => artifact.status === "done").length;
  if (done === change.artifacts.length && tasks.total > 0) return { ...tasks, unit: "tasks" };
  return { done, total: change.artifacts.length, unit: "artifacts" };
}
