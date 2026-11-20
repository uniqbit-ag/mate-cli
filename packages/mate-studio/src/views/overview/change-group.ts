import {
  defaultWorkflow,
  stagesBeforeWork,
  stepStage,
  type HandoffAction,
  type SkillAction,
  type StudioChange,
  type StudioSubmittedChange,
  type Workflow,
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

/** The stages a change walks: the required ones up to submit, as its panel lists them. */
export function changePath(workflow: Workflow = DEFAULT_WORKFLOW): WorkflowStage[] {
  const passed = stagesBeforeWork(workflow);
  return workflow.stages.filter(
    (stage) => !stage.optional && stage.id !== "publish" && !passed.includes(stage),
  );
}

/** The prompt of a skill action in the fallback `/name` syntax. */
const promptOf = (action: SkillAction): string =>
  `/${action.skill}${action.change ? ` ${action.change}` : ""}`;

/** The artifact id of a review action (`Review specs: <path>`); null for another text. */
const reviewedId = (action: HandoffAction): string | null =>
  action.kind === "text" ? (/^Review ([^:]+):/.exec(action.text)?.[1] ?? null) : null;

const NOT_PLACED: ChangeStep = {
  stage: "Not placed",
  stageId: null,
  review: false,
  situation: "Its position is not known",
  next: "Reload Studio",
  prompt: "",
};

/**
 * Where the change is on the companion's Delivery Path and what comes next, as its payload
 * position says: what `mate workflow next` computes for it.
 */
export function changeStep(
  change: StudioChange,
  workflow: Workflow = DEFAULT_WORKFLOW,
): ChangeStep {
  const { position } = change;
  if (!position) return NOT_PLACED;
  const { stage } = position;
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
  const { actions } = position.handoff;
  const action = actions.find((entry): entry is SkillAction => entry.kind === "skill");
  const at = { stage: stage.label, stageId: stage.id, prompt: action ? promptOf(action) : "" };
  if (stage.kind === "review") {
    const reviews = actions.map(reviewedId).filter((id): id is string => id !== null);
    const follows = action ? stepStage(workflow, action.skill)?.label : undefined;
    return {
      ...at,
      review: true,
      situation: "Plan ready for review",
      next: `Review ${reviews.length > 0 ? reviews.join(", ") : "the plan"}, then run ${follows ?? "the next stage"}`,
    };
  }
  // A later step of the stage is named by its skill.
  const runs = !action || action.skill === stage.entry ? stage.label : action.skill;
  return { ...at, review: false, situation: position.open ?? "Ready", next: `Run ${runs}` };
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
