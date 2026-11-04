import {
  compareRanked,
  rankOf,
  WORKSET_STAGE_ORDER,
  type FactoryRunView,
  type Situation,
  type StudioWorkset,
  type WorksetStageId,
} from "@uniqbit/mate-core/studio";

/**
 * The Factory home's model: Outcomes (Worksets as a person sees them), the decisions they
 * wait on, and what the factory reported. Pure, so the view stays thin.
 */

export interface OutcomeItem {
  workset: StudioWorkset;
  run: FactoryRunView | undefined;
}

export type AttentionKind = "control" | "decision" | "review" | "merge" | "publish" | "problem";

const ACTIVE = new Set(["queued", "running"]);

/** Why an Outcome waits on a person, or `null` when it does not. */
export function attentionKind(
  workset: StudioWorkset,
  run: FactoryRunView | undefined,
): AttentionKind | null {
  if (workset.stage === "done") return null;
  if (run?.control?.mode === "manual") return "control";
  if (run?.state === "waiting") return "decision";
  if (run?.state === "failed" || run?.state === "interrupted") return "problem";
  if (run && ACTIVE.has(run.state)) return null;
  if (workset.stage === "human-review") return "review";
  if (workset.stage === "merge-wait") return "merge";
  if (workset.stage === "publish") return "publish";
  return null;
}

function byId(a: OutcomeItem, b: OutcomeItem): number {
  return a.workset.id < b.workset.id ? -1 : a.workset.id > b.workset.id ? 1 : 0;
}

/** When an Outcome started waiting, as far as Studio knows; unknown sorts last. */
function waitingSince(item: OutcomeItem): number {
  const parsed = Date.parse(item.run?.updatedAt || item.workset.queuedAt || "");
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function itemsOf(
  worksets: readonly StudioWorkset[],
  runs: Record<string, FactoryRunView> | null,
): OutcomeItem[] {
  return worksets.map((workset) => ({ workset, run: runs?.[workset.id] }));
}

export interface FactoryHome {
  attention: (OutcomeItem & { kind: AttentionKind })[];
  active: OutcomeItem[];
  later: OutcomeItem[];
  completed: OutcomeItem[];
}

function rankCompare(a: OutcomeItem, b: OutcomeItem): number {
  return compareRanked(
    { id: a.workset.id, rank: rankOf(a.workset) },
    { id: b.workset.id, rank: rankOf(b.workset) },
  );
}

/** When an Outcome last changed, newest-first ordering for the history. */
function lastChange(item: OutcomeItem): number {
  const stamps = [item.run?.situations?.[0]?.at, item.run?.updatedAt, item.workset.queuedAt];
  return Math.max(0, ...stamps.map((stamp) => Date.parse(stamp ?? "")).filter(Number.isFinite));
}

/** A Later Outcome that already has a plan, or a run, is under way all the same. */
function underWay(item: OutcomeItem): boolean {
  return (
    item.workset.queuedAt !== undefined ||
    item.workset.changes.length > 0 ||
    (item.run !== undefined && item.run.state !== "idle")
  );
}

/** Every Outcome where the home shows it; the view lists one that needs the person only there. */
export function factoryHome(
  worksets: readonly StudioWorkset[],
  runs: Record<string, FactoryRunView> | null,
): FactoryHome {
  const items = itemsOf(worksets, runs);
  const attention = items
    .flatMap((item) => {
      const kind = attentionKind(item.workset, item.run);
      return kind ? [{ ...item, kind }] : [];
    })
    .toSorted((a, b) => waitingSince(a) - waitingSince(b) || byId(a, b));
  const open = items.filter((item) => item.workset.stage !== "done");
  return {
    attention,
    active: open.filter(underWay).toSorted(rankCompare),
    later: open.filter((item) => !underWay(item)).toSorted(byId),
    completed: items
      .filter((item) => item.workset.stage === "done")
      .toSorted((a, b) => lastChange(b) - lastChange(a) || byId(a, b)),
  };
}

export interface Milestone {
  label: string;
  reached: boolean;
}

/** Each milestone is reached once the Outcome's stage is past the one named. */
const MILESTONES: readonly { label: string; after: WorksetStageId; next: string }[] = [
  {
    label: "Understood",
    after: "clarify-intent",
    next: "The factory is working out what you want",
  },
  { label: "Approach chosen", after: "explore", next: "The factory is choosing the approach" },
  { label: "Plan ready", after: "propose", next: "The factory is writing the plan" },
  { label: "Plan approved", after: "human-review", next: "Ready for your review" },
  { label: "Built", after: "apply", next: "The factory is building it" },
  { label: "Merged", after: "merge-wait", next: "Ready for you to merge" },
  { label: "Delivered", after: "publish", next: "Ready to publish" },
];

function stageIndex(stage: WorksetStageId): number {
  return WORKSET_STAGE_ORDER.indexOf(stage);
}

export function milestonesOf(workset: StudioWorkset): Milestone[] {
  const at = stageIndex(workset.stage);
  return MILESTONES.map((milestone) => ({
    label: milestone.label,
    reached: at > stageIndex(milestone.after),
  }));
}

function savedForLater(workset: StudioWorkset, run: FactoryRunView | undefined): boolean {
  return !workset.queuedAt && workset.changes.length === 0 && (!run || run.state === "idle");
}

/** The next meaningful step, phrased by who acts next. */
export function nextStepOf(workset: StudioWorkset, run: FactoryRunView | undefined): string {
  if (workset.stage === "done") return "Delivered";
  if (run?.control?.mode === "manual") return "You have control";
  if (run?.state === "waiting") return "Waiting for your answer";
  if (run?.state === "failed" || run?.state === "interrupted") return "Stopped; needs you";
  if (savedForLater(workset, run)) return "Saved for later";
  const at = stageIndex(workset.stage);
  return MILESTONES.find((milestone) => at <= stageIndex(milestone.after))?.next ?? "Delivered";
}

const DERIVED: Partial<Record<WorksetStageId, string>> = {
  "clarify-intent": "Understanding what you want.",
  explore: "Working out the approach.",
  propose: "Writing the plan.",
  "human-review": "A plan is ready for your review.",
  apply: "Building it.",
  "merge-wait": "Built; waiting for the merge.",
  publish: "Merged; ready to publish.",
  done: "Delivered.",
};

/** A sentence from the stage, for an Outcome the agent has not reported on. */
export function derivedSituation(workset: StudioWorkset, run: FactoryRunView | undefined): string {
  if (run?.state === "queued") {
    if (run.waiting === "workset-slot") return "Waiting for a Workset slot.";
    if (run.waiting === "build-slot") return "Waiting for a build slot.";
    return "Waiting for a free slot.";
  }
  if (run?.state === "failed") return `Stopped: ${run.reason}`;
  if (run?.state === "interrupted") return "Stopped when Studio restarted.";
  if (run?.state === "waiting") return "Waiting for your answer.";
  if (savedForLater(workset, run)) return "Saved for later.";
  return DERIVED[workset.stage] ?? workset.stageLabel;
}

/** Run states that say more than the last report; queued, waiting, failed and interrupted. */
const OVERRIDING = new Set(["queued", "waiting", "failed", "interrupted"]);

/** The latest reported situation, or a derived one without a time. */
export function situationOf(
  workset: StudioWorkset,
  run: FactoryRunView | undefined,
): Pick<Situation, "text" | "checks"> & { at?: string } {
  const reported = run?.situations?.[0];
  if (reported && !(run && OVERRIDING.has(run.state))) return reported;
  return { text: derivedSituation(workset, run) };
}

/** How an Outcome stands right now: its row's dot and its node on the Delivery Path map. */
export type Activity =
  | "running"
  | "queued"
  | "needs-you"
  | "control"
  | "stopped"
  | "idle"
  | "later"
  | "done";

export const ACTIVITY_LABELS: Record<Activity, string> = {
  running: "Running",
  queued: "Queued",
  "needs-you": "Needs you",
  control: "You have control",
  stopped: "Stopped",
  idle: "Idle",
  later: "Saved for later",
  done: "Delivered",
};

export function activityOf(workset: StudioWorkset, run: FactoryRunView | undefined): Activity {
  if (workset.stage === "done") return "done";
  if (run?.control?.mode === "manual") return "control";
  if (run?.state === "failed" || run?.state === "interrupted") return "stopped";
  if (run?.state === "running") return "running";
  if (run?.state === "queued") return "queued";
  if (attentionKind(workset, run)) return "needs-you";
  return underWay({ workset, run }) ? "idle" : "later";
}

/** The Delivery Path map node each stage sits at; `complete` once delivered. */
const PATH_NODES: Record<WorksetStageId, string> = {
  "clarify-intent": "clarify-intent",
  explore: "explore",
  propose: "propose",
  "human-review": "reviews",
  apply: "apply",
  // Archive may run before the merge; the merge gate is what Publish waits on.
  "merge-wait": "archive",
  publish: "publish",
  done: "complete",
};

export const pathNodeOf = (workset: StudioWorkset): string => PATH_NODES[workset.stage];
