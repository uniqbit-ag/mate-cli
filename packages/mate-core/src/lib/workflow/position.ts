import {
  BUILTIN_ARTIFACT_TYPE,
  nextStage,
  type Workflow,
  type WorkflowSkillStage,
  type WorkflowStage,
} from "../../runtime/workflow/workflow";
import type { Handoff, HandoffAction, SkillAction, TextAction } from "./handoff";

/**
 * The Path Position: where a piece of work stands on its companion's Delivery Path and what
 * follows, as data. It reads no files and never assumes the work is a change: an adapter fills
 * its input. Imports nothing beyond the workflow model, so Studio's bundle can use it too.
 */

/** What the work's plan says, which the Milestones `planned` and `implemented` are read from. */
export interface PathPlan {
  /** The plan validates. */
  valid: boolean;
  totalTasks: number;
  completedTasks: number;
}

/** What is known of the work's progress. */
export interface PathProgress {
  /** The steps recorded for it, by stage id. */
  steps: Readonly<Record<string, readonly string[]>>;
  state?: "active" | "submitted" | "dropped";
  /** Absent for work whose type has no plan, which says nothing of its plan's Milestones. */
  plan?: PathPlan;
}

/** What a hand-off names of the work; every field is optional. */
export interface PathSubject {
  /** Named in every invocation. */
  name?: string;
  /** The artifacts a review can name that the work has, in review order. */
  artifacts?: ReadonlyArray<{ id: string; path: string }>;
  /** Its delivery branches that are not merged. */
  unmerged?: readonly string[];
}

export interface PathPosition {
  /** The stage the work is at; null for dropped work. Without progress, the first required one. */
  stage: WorkflowStage | null;
  /** What keeps that skill stage from being done, in a few words; null when nothing does. */
  open: string | null;
  /** By skill stage id: its steps not done, in chain order. */
  openSteps: Record<string, string[]>;
  /** By stage id: the steps that count as done without a report, in Delivery Path order. */
  counted: Record<string, string[]>;
  /** The required skill stages before `submit` that are not done, each with what keeps it open. */
  unfinished: Array<{ stage: WorkflowSkillStage; open: string }>;
  /** What the developer starts next. */
  handoff: Handoff;
  /**
   * After step `after`: its stage's steps not done when the report records it, else the chain's
   * steps after it, in chain order. Absent without `after`.
   */
  remaining?: string[];
}

/** What reporting a step does. */
export interface StepReport {
  stage: WorkflowSkillStage;
  /**
   * A report records the step when the work exists. An optional stage and publication record
   * none, `submit` none from its Mate stage skill on: the work's state says where it is.
   */
  records: boolean;
  /**
   * The work must exist: false for a step that runs before it can, and after publication, when
   * it is archived.
   */
  needsWork: boolean;
}

const NO_PROGRESS: PathProgress = { steps: {} };

/**
 * The stages work has always passed once it exists: for the built-in type, those up to the one
 * reaching `exists`. A declared type's work is placed by its steps alone.
 */
export function stagesBeforeWork(workflow: Workflow): WorkflowStage[] {
  if (workflow.submitArtifact !== BUILTIN_ARTIFACT_TYPE) return [];
  const exists = workflow.stages.findIndex(
    (stage) => stage.kind === "skill" && stage.milestone === "exists",
  );
  return workflow.stages.slice(0, exists + 1);
}

/** Whether the work's state, not a report, says `stage` is reached: submit and publish. */
const heldByState = (stage: WorkflowSkillStage): boolean =>
  stage.milestone === "submitted" || stage.milestone === "published";

/** The skill stage whose steps name `skill`; a skill is one step of the Delivery Path. */
export function stepStage(workflow: Workflow, skill: string): WorkflowSkillStage | undefined {
  return workflow.stages.find(
    (stage): stage is WorkflowSkillStage =>
      stage.kind === "skill" && stage.steps.some((step) => step.skill === skill),
  );
}

/**
 * The steps of `stage` a report records, a prefix of its chain. An optional stage and the one
 * reaching `published` record none, and the one reaching `submitted` only those before its Mate
 * stage skill: the work's state and its publication say where it is.
 */
function recordedSteps(stage: WorkflowSkillStage): WorkflowSkillStage["steps"] {
  if (stage.optional || stage.milestone === "published") return [];
  const end = heldByState(stage) ? stage.steps.findIndex((step) => step.own) : -1;
  return end >= 0 ? stage.steps.slice(0, end) : stage.steps;
}

/** Whether a report records step `skill` of `stage`. */
const records = (stage: WorkflowSkillStage, skill: string): boolean =>
  stage.steps.findIndex((step) => step.skill === skill) < recordedSteps(stage).length;

/**
 * Whether `stage` runs before the work can exist: the path's first required stage, an optional
 * one ahead of it, or one the work has always passed. Its step has nothing to record yet.
 */
function opensPath(workflow: Workflow, stage: WorkflowSkillStage): boolean {
  if (stagesBeforeWork(workflow).includes(stage)) return true;
  const first = workflow.stages.findIndex((each) => !each.optional);
  return workflow.stages.indexOf(stage) <= first;
}

/** What reporting step `skill` does; undefined for a skill that is no step. */
export function stepReport(workflow: Workflow, skill: string): StepReport | undefined {
  const stage = stepStage(workflow, skill);
  if (!stage) return undefined;
  return {
    stage,
    records: records(stage, skill),
    needsWork: stage.milestone !== "published" && !opensPath(workflow, stage),
  };
}

// --- Stage and step rules ---

/**
 * Whether the work holds the Milestone `stage` reaches; undefined when the stage reaches none or
 * the work cannot say. `exists` is read from the plan until work that is not a change reports it.
 */
function milestone(stage: WorkflowSkillStage, progress: PathProgress): boolean | undefined {
  const { plan, state } = progress;
  switch (stage.milestone) {
    case "exists":
      return plan ? true : undefined;
    case "planned":
      return plan ? plan.valid && plan.totalTasks > 0 : undefined;
    case "implemented":
      return plan ? plan.totalTasks > 0 && plan.completedTasks === plan.totalTasks : undefined;
    case "submitted":
      return state === "submitted";
    case "published":
      // Published work is archived: no work is left to place.
      return false;
    default:
      return undefined;
  }
}

/** Why the work does not hold `stage`'s Milestone, in a few words; null when nothing says. */
function missing(stage: WorkflowSkillStage, progress: PathProgress): string | null {
  const { plan } = progress;
  switch (stage.milestone) {
    case "planned":
      if (!plan) return null;
      if (!plan.valid) return "the change does not validate";
      return plan.totalTasks === 0 ? "no tasks" : null;
    case "implemented": {
      if (!plan) return null;
      if (plan.totalTasks === 0) return "no tasks";
      const open = plan.totalTasks - plan.completedTasks;
      return open > 0 ? `${open} ${open === 1 ? "task" : "tasks"} open` : null;
    }
    case "submitted":
      return progress.state === "submitted" ? null : "not submitted";
    default:
      return null;
  }
}

/** The steps of `stage` neither recorded nor covered by its Milestone, in chain order. */
function unreported(stage: WorkflowSkillStage, progress: PathProgress): string[] {
  const recorded = progress.steps[stage.id] ?? [];
  const covered = milestone(stage, progress) === true;
  return stage.steps
    .filter((step) => !recorded.includes(step.skill) && !(step.own && covered))
    .map((step) => step.skill);
}

/** The steps work can wait at, in Delivery Path order: those a report records. */
function waitableSteps(workflow: Workflow): Array<{ stage: WorkflowSkillStage; skill: string }> {
  return workflow.stages.flatMap((stage) =>
    stage.kind === "skill"
      ? recordedSteps(stage).map((step) => ({ stage, skill: step.skill }))
      : [],
  );
}

/**
 * The steps that count as done without a report, by stage id: neither recorded nor covered by a
 * Milestone, while a later step of the Delivery Path is recorded or the work is submitted. Starting a
 * later step is the developer saying the earlier one is finished. Computed, never stored.
 */
function countedSteps(workflow: Workflow, progress: PathProgress): Record<string, string[]> {
  const steps = waitableSteps(workflow);
  const last =
    progress.state === "submitted"
      ? steps.length
      : steps.findLastIndex(({ stage, skill }) => progress.steps[stage.id]?.includes(skill));
  const counted: Record<string, string[]> = {};
  for (const { stage, skill } of steps.slice(0, Math.max(last, 0))) {
    if (!unreported(stage, progress).includes(skill)) continue;
    (counted[stage.id] ??= []).push(skill);
  }
  return counted;
}

/**
 * The steps of `stage` not done, in chain order. A step is done when it is recorded, when it is
 * the stage's Mate stage skill and the work holds the stage's Milestone, or when it counts
 * because a later step is recorded: a missed report blocks nothing.
 */
function openSteps(
  stage: WorkflowSkillStage,
  progress: PathProgress,
  counted: Record<string, string[]>,
): string[] {
  const skipped = counted[stage.id] ?? [];
  return unreported(stage, progress).filter((skill) => !skipped.includes(skill));
}

/** Whether stage `index` is done; a later check joins its list. */
function isDone(
  workflow: Workflow,
  index: number,
  progress: PathProgress,
  counted: Record<string, string[]>,
): boolean {
  const stage = workflow.stages[index]!;
  if (stage.kind === "skill") {
    const held = milestone(stage, progress);
    // From its Mate stage skill on, the work's state says it: nothing is recorded.
    if (heldByState(stage)) return held === true;
    return openSteps(stage, progress, counted).length === 0 && held !== false;
  }
  // A review has no signal of its own: started work, or a step recorded later, passes it.
  const later = workflow.stages
    .slice(index + 1)
    .some((next) => (progress.steps[next.id]?.length ?? 0) > 0);
  const { plan } = progress;
  return later || progress.state === "submitted" || (plan !== undefined && plan.completedTasks > 0);
}

/**
 * The stage the work is at; null for dropped work, which is at none. Submitted work is at the
 * path's last stage, the one reaching `published`.
 */
function stageAt(
  workflow: Workflow,
  progress: PathProgress,
  counted: Record<string, string[]>,
): WorkflowStage | null {
  if (progress.state === "dropped") return null;
  const last = workflow.stages.at(-1) ?? null;
  if (progress.state === "submitted") return last;
  return (
    workflow.stages.find(
      (stage, index) => !stage.optional && !isDone(workflow, index, progress, counted),
    ) ?? last
  );
}

/** What keeps `stage` from being done, in a few words; null when nothing does. */
function openWork(
  stage: WorkflowSkillStage,
  progress: PathProgress,
  counted: Record<string, string[]>,
): string | null {
  // The Milestone first: it is why the stage's Mate stage skill is not done.
  const reason = missing(stage, progress);
  if (reason || heldByState(stage)) return reason;
  const steps = openSteps(stage, progress, counted);
  return steps.length > 0 ? `${steps.join(", ")} not recorded` : null;
}

// --- Hand-off ---

const skill = (name: string, subject?: string): SkillAction => ({
  kind: "skill",
  skill: name,
  ...(subject ? { change: subject } : {}),
});

const text = (value: string): TextAction => ({ kind: "text", text: value });

const NOTHING: Handoff = { actions: [], optional: [], counted: [] };

function buildHandoff(
  optional: SkillAction[],
  actions: HandoffAction[],
  counted: SkillAction[] = [],
): Handoff {
  return actions.length === 0 ? NOTHING : { actions, optional, counted };
}

/** The optional skill stages among `stages`; always offered, since none is recorded. */
function optionalStages(stages: readonly WorkflowStage[], name?: string): SkillAction[] {
  return stages.flatMap((stage) =>
    stage.kind === "skill" && stage.optional ? [skill(stage.entry, name)] : [],
  );
}

/**
 * The hand-off of a stage that ends before the work exists, or of none (`finished` null): the
 * next stage in order, named for the work when it has a name already.
 */
function orderHandoff(
  workflow: Workflow,
  finished: WorkflowSkillStage | null,
  name?: string,
): Handoff {
  const optional: SkillAction[] = [];
  let id = finished?.id;
  if (id === undefined) {
    const first = workflow.stages.find((stage) => !stage.optional);
    if (first?.kind !== "skill") return NOTHING;
    const ahead = workflow.stages.slice(0, workflow.stages.indexOf(first));
    return buildHandoff(optionalStages(ahead, name), [skill(first.entry, name)]);
  }
  for (;;) {
    const next = nextStage(workflow, id);
    if (!next) return NOTHING;
    optional.push(...next.optional.map((stage) => skill(stage.entry, name)));
    if (next.kind === "skill") return buildHandoff(optional, [skill(next.entry!, name)]);
    // Nothing to review yet.
    id = next.id;
  }
}

/**
 * The step of `stage` the developer starts next: the stage's Mate stage skill while the plan
 * leaves its Milestone open, which `open` then names, else its first step that is not done.
 */
function stepToRun(
  stage: WorkflowSkillStage,
  progress: PathProgress,
  open: readonly string[],
): { skill: string; open: string | null } {
  // A Milestone held by state opens no work of its own: its steps run in order.
  const reason = heldByState(stage) ? null : missing(stage, progress);
  if (!reason) return { skill: open[0] ?? stage.entry, open: null };
  return { skill: stage.steps.find((step) => step.own)?.skill ?? stage.entry, open: reason };
}

interface Placed {
  progress: PathProgress;
  stage: WorkflowStage | null;
  counted: Record<string, string[]>;
  openSteps: Record<string, string[]>;
}

/**
 * The hand-off after a step of `finished` was reported, or with `finished` null where the work
 * stands; empty when nothing follows: after publication, or for dropped work. Steps counted without
 * a report are named above the section until the work is submitted; the submit warning names
 * them then.
 */
function progressHandoff(
  workflow: Workflow,
  finished: WorkflowSkillStage | null,
  placed: Placed,
  subject: PathSubject,
): Handoff {
  const { progress, stage: position } = placed;
  if (!position) return NOTHING;
  const { name } = subject;
  const at = workflow.stages.indexOf(position);
  // Without a finished stage, the optional stages since the last required one before the position.
  const from = finished
    ? workflow.stages.findIndex((stage) => stage.id === finished.id)
    : workflow.stages.findLastIndex((stage, index) => index < at && !stage.optional);
  // The optional stages passed on the way from the finished stage.
  const passed = (to: number): SkillAction[] =>
    optionalStages(workflow.stages.slice(from + 1, Math.max(to, from + 1)), name);

  if (progress.state === "submitted") {
    if (finished?.milestone === "published" || position.kind !== "skill") return NOTHING;
    return buildHandoff(passed(at), [
      ...(subject.unmerged ?? []).map((branch) => text(`Merge ${branch}`)),
      skill(position.entry),
    ]);
  }
  const counted = Object.values(placed.counted).flatMap((skills) =>
    skills.map((each) => skill(each, name)),
  );
  if (position.kind === "skill") {
    const here = !finished || position.id === finished.id;
    const next = stepToRun(position, progress, placed.openSteps[position.id] ?? []);
    // Waiting for a state is news only right after the step that should set it; `next.open` is
    // null for a stage held by state.
    const open = heldByState(position) && finished ? missing(position, progress) : next.open;
    const action = skill(next.skill, name);
    return buildHandoff(passed(at), [here && open ? { ...action, note: open } : action], counted);
  }
  // The reviews up to the next skill stage, then that stage as following them.
  const artifacts = subject.artifacts ?? [];
  const reviews: TextAction[] = [];
  let follower = workflow.stages.length;
  for (let index = at; index < workflow.stages.length; index += 1) {
    const stage = workflow.stages[index]!;
    if (stage.optional) continue;
    if (stage.kind === "skill") {
      follower = index;
      break;
    }
    const reviewed =
      stage.review === "schema"
        ? artifacts
        : stage.review.flatMap((id) => artifacts.filter((artifact) => artifact.id === id));
    reviews.push(...reviewed.map((artifact) => text(`Review ${artifact.id}: ${artifact.path}`)));
  }
  const next = workflow.stages[follower];
  return buildHandoff(
    passed(follower),
    [
      ...reviews,
      ...(next?.kind === "skill"
        ? [{ ...skill(next.entry, name), afterReview: true as const }]
        : []),
    ],
    counted,
  );
}

/** The steps of `stage`'s chain after step `after`. */
const chainAfter = (stage: WorkflowSkillStage, after: string): string[] =>
  stage.steps
    .slice(stage.steps.findIndex((step) => step.skill === after) + 1)
    .map((step) => step.skill);

/**
 * The hand-off after step `after` was reported: the next step of its chain where steps are not
 * recorded, else the stage after it without progress, else from where the work then stands.
 */
function handoffAfter(
  workflow: Workflow,
  stage: WorkflowSkillStage,
  after: string,
  recorded: boolean,
  placed: Placed | null,
  subject: PathSubject,
): Handoff {
  const next = chainAfter(stage, after)[0];
  // Where steps are not recorded, the chain's order is all there is to go by.
  if (next !== undefined && !recorded) return buildHandoff([], [skill(next, subject.name)]);
  if (!placed) return orderHandoff(workflow, stage, subject.name);
  return progressHandoff(workflow, stage, placed, subject);
}

/**
 * Where the work stands on `workflow` and what follows. `progress` null means the work does not
 * exist yet: only the stage order is known. `after` is the step just reported; the hand-off is
 * then the one `mate workflow done <after>` prints. A skill that is no step is ignored.
 */
export function pathPosition(
  workflow: Workflow,
  progress: PathProgress | null,
  subject: PathSubject = {},
  after?: string,
): PathPosition {
  const finished = after === undefined ? undefined : stepStage(workflow, after);
  const known = progress ?? NO_PROGRESS;
  const counted = progress ? countedSteps(workflow, progress) : {};
  const open: Record<string, string[]> = {};
  for (const stage of workflow.stages) {
    if (stage.kind === "skill") open[stage.id] = openSteps(stage, known, counted);
  }
  const stage = progress
    ? stageAt(workflow, progress, counted)
    : (workflow.stages.find((each) => !each.optional) ?? null);
  const placed: Placed | null = progress ? { progress, stage, counted, openSteps: open } : null;
  const unfinished = workflow.stages.flatMap((each, index) =>
    each.kind === "skill" &&
    !each.optional &&
    !heldByState(each) &&
    !isDone(workflow, index, known, counted)
      ? [
          {
            stage: each,
            open: openWork(each, known, counted) ?? "its steps are not recorded",
          },
        ]
      : [],
  );
  let handoff: Handoff;
  let remaining: string[] | undefined;
  if (finished && after !== undefined) {
    const recorded = placed !== null && records(finished, after);
    handoff = handoffAfter(workflow, finished, after, recorded, placed, subject);
    // A step not recorded has only the chain's order to go by.
    remaining = recorded ? (open[finished.id] ?? []) : chainAfter(finished, after);
  } else if (placed) {
    handoff = progressHandoff(workflow, null, placed, subject);
  } else {
    handoff = orderHandoff(workflow, null, subject.name);
  }
  return {
    stage,
    open:
      stage?.kind === "skill" && known.state !== "submitted"
        ? openWork(stage, known, counted)
        : null,
    openSteps: open,
    counted,
    unfinished,
    handoff,
    ...(remaining ? { remaining } : {}),
  };
}
