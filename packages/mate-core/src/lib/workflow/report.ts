import type { Workflow } from "./declaration";
import type { Handoff } from "./handoff";
import { pathPosition, stepReport } from "./position";
import type { Work, WorkItem } from "./work";

/**
 * A step report: `mate workflow done` saying a step finished. Decides nothing itself: the Path
 * Position says what the report records and what follows, `Work` finds and records the work.
 */

/** What a reported step did and what follows it. */
export interface ReportedStep {
  stage: string;
  /** Null without a named piece of work. */
  change: string | null;
  step: string;
  /** False for a step whose end the work's state or its publication records. */
  recorded: boolean;
  /** The stage's steps not done, in chain order. */
  remaining: string[];
  /** The work's steps that count as done without a report, by stage id. */
  counted: Record<string, string[]>;
  complete: boolean;
  handoff: Handoff;
}

/** The refusal of `skill` that is no step, naming each skill stage's steps to run instead. */
export function noStep(workflow: Workflow, skill: string): string {
  const steps = workflow.stages
    .flatMap((stage) =>
      stage.kind === "skill"
        ? [`${stage.id} (${stage.steps.map((step) => step.skill).join(", ")})`]
        : [],
    )
    .join("; ");
  return `${skill} is no step of the Delivery Path; the steps are ${steps}.`;
}

/**
 * Reports step `skill` for the work named `name`, recording it when the stage records it. A
 * missing work is a problem only where it should exist; before that, and without `name`, the
 * hand-off goes by stage order. Throws on a record that cannot be read or written.
 */
export async function reportStep(
  work: Work,
  workflow: Workflow,
  skill: string,
  name?: string,
): Promise<ReportedStep | { problem: string }> {
  const rule = stepReport(workflow, skill);
  if (!rule) return { problem: noStep(workflow, skill) };
  let item: WorkItem | null = null;
  // After publication the work is archived, so the stage reaching `published` looks for none.
  if (name && rule.stage.milestone !== "published") {
    const found = await work.find(name);
    if (!("problem" in found)) item = found;
    else if (rule.needsWork) return found;
  }
  const records = item !== null && rule.records;
  if (records) await item!.recordStep(rule.stage.id, skill);
  const input = item ? await item.input() : null;
  const position = pathPosition(
    workflow,
    input?.progress ?? null,
    input?.subject ?? (name ? { name } : {}),
    skill,
  );
  const remaining = position.remaining ?? [];
  return {
    stage: rule.stage.id,
    change: name ?? null,
    step: skill,
    recorded: records,
    remaining,
    counted: position.counted,
    complete: remaining.length === 0,
    handoff: position.handoff,
  };
}
