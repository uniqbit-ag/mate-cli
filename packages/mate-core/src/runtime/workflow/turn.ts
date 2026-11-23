/**
 * One turn of an agent session on the Delivery Path: the step it starts, each
 * `mate workflow done` it runs, and the decision at its end. Runtime-free; each runtime's
 * adapter notes the turn and acts on the verdict. Records nothing; the hand-off comes from
 * `mate workflow next`, which the adapter fetches.
 */
import {
  formatInvocation,
  invokedSkill,
  isInvocationChange,
  namesInvocation,
  parseInvocations,
  type AgentRuntime,
  type Invocation,
} from "../skill-prefix";
import { record } from "../json-fields";
import { readWorkflow } from "./declaration";
import type { Workflow, WorkflowVerdict } from "./workflow";

/** A step and the change it ran for; a report without a change has `change: ""`. */
export type Step = Invocation;

/**
 * What one turn of a session started and reported: `reports` as read from its commands' text,
 * `recorded` as `mate workflow done` noted them, which win when the turn has any.
 */
export interface Turn {
  step?: Step;
  reports: Step[];
  recorded?: Step[];
}

/**
 * A hand-off as `mate workflow next --json` prints it: `handoff`, the `## Next steps` section shown
 * or sent back as printed, and `actions`, its skill actions that name a change, which a written
 * section is checked against.
 */
export interface PrintedHandoff {
  handoff: string;
  actions: Step[];
}

/** What a finished turn calls for: nothing, a hand-off shown to the user, or one send-back. */
export type TurnVerdict =
  | { kind: "pass" }
  | { kind: "notice"; text: string }
  | { kind: "sendBack"; reason: string };

/** A hand-off a verdict reads: the change's, after the turn's last report for it. */
export interface HandoffQuery {
  change: string;
  after?: string;
}

export interface FinishOptions {
  /** The Session Companion whose workflow the turn is judged by. */
  companionPath: string;
  /** The turn was already sent back once, so it only gets a notice. */
  again: boolean;
  runtime: AgentRuntime;
  /** The turn's last response; read only when a hand-off holds it to a section. */
  response: () => Promise<string>;
  fetchHandoff: (query: HandoffQuery) => Promise<PrintedHandoff | null>;
  /** Whether the runtime has the turn judged at all; asked once the workflow reads valid. */
  judges?: () => Promise<boolean>;
}

export interface FinishDeps {
  readWorkflow?: (companionPath: string) => WorkflowVerdict;
}

const SKILL = "[a-z0-9][a-z0-9-]*";
const CHANGE = "[A-Za-z0-9][A-Za-z0-9._-]*";
const GAP = "[ \\t]+";
const FLAGS = `(?:${GAP}--?[A-Za-z][\\w-]*)*`;
/**
 * `mate workflow done <skill> [<change>]`, flags anywhere; the change must end its word, so a
 * redirection such as `2>&1` is no change.
 */
const REPORT = new RegExp(
  `\\bmate${GAP}workflow${GAP}done${FLAGS}${GAP}["']?(${SKILL})["']?(?:${FLAGS}${GAP}["']?(${CHANGE})(?=["']?(?:[\\s;&|)]|$)))?`,
  "g",
);
const SECTION = /^##\s+Next steps\s*$/gm;
const PASS: TurnVerdict = { kind: "pass" };

export function turnHooksEnabled(env: Record<string, string | undefined>): boolean {
  return !["off", "0", "false"].includes((env.MATE_TURN_HOOKS ?? "").trim().toLowerCase());
}

/** A turn started by `prompt`, with the step it invokes, if any. */
export function startTurn(prompt: string): Turn {
  const step = invokedSkill(prompt);
  return { ...(step ? { step } : {}), reports: [] };
}

/**
 * The turn with `skill` run for `change` as its step; the same turn when `skill` is empty or
 * `change` is no change name, such as a flag from a skill's arguments.
 */
export function noteSkill(turn: Turn, skill: string, change: string): Turn {
  return skill && isInvocationChange(change) ? { ...turn, step: { skill, change } } : turn;
}

/** The turn with the steps a shell command reports; the same turn when it reports none. */
export function noteShell(turn: Turn, command: string): Turn {
  const reports = reportedSteps(command);
  return reports.length === 0 ? turn : { ...turn, reports: [...turn.reports, ...reports] };
}

/** Each `mate workflow done <skill> [<change>]` in a shell command. */
export function reportedSteps(command: string): Step[] {
  return [...command.matchAll(REPORT)].map((match) => ({
    skill: match[1]!,
    change: match[2] ?? "",
  }));
}

const SKILL_WORD = new RegExp(`^${SKILL}$`);

/**
 * The turn with the steps `mate workflow done` recorded, `recorded` as it noted them; an entry
 * that names no step or a change that is no change name is dropped.
 */
export function noteRecorded(turn: Turn, recorded: unknown): Turn {
  const steps = (Array.isArray(recorded) ? recorded : []).flatMap((value: unknown) => {
    const { skill, change } = record(value);
    const valid =
      typeof skill === "string" &&
      SKILL_WORD.test(skill) &&
      typeof change === "string" &&
      (change === "" || isInvocationChange(change));
    return valid ? [{ skill, change }] : [];
  });
  return steps.length === 0 ? turn : { ...turn, recorded: [...(turn.recorded ?? []), ...steps] };
}

/** The turn as judged: its recorded steps as its reports when it has any. */
function judgedTurn(turn: Turn): Turn {
  const { recorded, ...rest } = turn;
  return recorded && recorded.length > 0 ? { ...rest, reports: recorded } : rest;
}

/** Whether the turn started a step or reported one; a turn without either always passes. */
export function hasNotes(turn: Turn): boolean {
  return turn.step !== undefined || turn.reports.length > 0 || (turn.recorded?.length ?? 0) > 0;
}

/**
 * The decision at the end of a turn: reads the companion's workflow, fetches the hand-offs the
 * turn reads, then judges the response. Passes without reading anything when the turn noted
 * nothing, and without fetching when the workflow declaration is invalid or `judges` declines.
 */
export async function finishTurn(
  noted: Turn,
  options: FinishOptions,
  deps: FinishDeps = {},
): Promise<TurnVerdict> {
  if (!hasNotes(noted)) return PASS;
  const turn = judgedTurn(noted);
  const read = (deps.readWorkflow ?? readWorkflow)(options.companionPath);
  if (!read.ok || (options.judges && !(await options.judges()))) return PASS;
  const handoffs = await fetchHandoffs(
    handoffQueries(turn, read.workflow, options.again),
    options.fetchHandoff,
  );
  return turnVerdict(turn, read.workflow, (change) => handoffs.get(change) ?? null, options);
}

/** Whether `skill` is a step of the Delivery Path that is not a Mate stage skill. */
function companionStep(workflow: Workflow, skill: string): boolean {
  return workflow.stages.some(
    (stage) =>
      stage.kind === "skill" && stage.steps.some((step) => step.skill === skill && !step.own),
  );
}

/** Whether `skill` is a step of a skill stage of the Delivery Path. */
function pathSkill(workflow: Workflow, skill: string): boolean {
  return workflow.stages.some(
    (stage) => stage.kind === "skill" && stage.steps.some((step) => step.skill === skill),
  );
}

/**
 * The hand-offs the verdict of a finished turn reads, one per change: after each reported
 * change's last report, or, for a turn that only started a companion's step, the change's.
 */
function handoffQueries(turn: Turn, workflow: Workflow, again: boolean): HandoffQuery[] {
  if (turn.reports.length > 0) {
    const last = new Map<string, string>();
    for (const report of turn.reports) if (report.change) last.set(report.change, report.skill);
    return [...last].map(([change, after]) => ({ change, after }));
  }
  const step = turn.step;
  return !again && step && companionStep(workflow, step.skill) ? [{ change: step.change }] : [];
}

/** Every query's hand-off at once, by change. */
async function fetchHandoffs(
  queries: readonly HandoffQuery[],
  fetch: (query: HandoffQuery) => Promise<PrintedHandoff | null>,
): Promise<Map<string, PrintedHandoff | null>> {
  return new Map(
    await Promise.all(queries.map(async (query) => [query.change, await fetch(query)] as const)),
  );
}

/** The response's last `## Next steps` section, quotes dropped; null without one. */
function writtenSection(response: string): string | null {
  const matches = [...response.matchAll(SECTION)];
  const last = matches.at(-1);
  return last?.index === undefined ? null : response.slice(last.index).replace(/["'`]/g, "");
}

/** The hand-offs' skill actions the written section does not name, in any prefix. */
function missingActions(sections: { printed: PrintedHandoff }[], written: string): Step[] {
  return sections
    .flatMap(({ printed }) => printed.actions)
    .filter((action) => !namesInvocation(written, action));
}

/**
 * The written section's numbered Delivery Path actions for a reported change that no hand-off
 * names: a session listing a stage's later steps beside the one printed.
 */
function extraActions(
  workflow: Workflow,
  sections: { change: string; printed: PrintedHandoff }[],
  written: string,
): Step[] {
  const key = (action: Step) => `${action.skill} ${action.change}`;
  // An action printed without a change, such as publish's, also covers it written with one.
  const printed = new Set(
    sections.flatMap(({ change, printed: handoff }) =>
      handoff.actions.map((action) => key(action.change ? action : { ...action, change })),
    ),
  );
  const changes = new Set(sections.map(({ change }) => change));
  return parseInvocations(written).filter(
    (action) =>
      changes.has(action.change) && pathSkill(workflow, action.skill) && !printed.has(key(action)),
  );
}

/** The verdict over the fetched hand-offs; `next` holds those `handoffQueries` names. */
async function turnVerdict(
  turn: Turn,
  workflow: Workflow,
  next: (change: string) => PrintedHandoff | null,
  { again, runtime, response }: FinishOptions,
): Promise<TurnVerdict> {
  if (turn.reports.length > 0) {
    // The turn's step reported without its change: nothing was recorded for it.
    const step = turn.step;
    const unnamed =
      step?.change &&
      turn.reports.some((report) => report.skill === step.skill && !report.change) &&
      !turn.reports.some((report) => report.skill === step.skill && report.change === step.change);
    if (unnamed && step) {
      if (again) return PASS;
      return {
        kind: "sendBack",
        reason: `\`mate workflow done ${step.skill}\` named no change, so nothing was recorded for ${step.change}. Run \`mate workflow done ${step.skill} "${step.change}"\` and end your response with a final \`## Next steps\` section listing the actions it prints, running none of them.`,
      };
    }
    // A report without a change has no hand-off to hold the section to.
    const changes = [...new Set(turn.reports.map((report) => report.change))].filter(Boolean);
    const sections = changes.flatMap((change) => {
      const printed = next(change);
      return printed ? [{ change, printed }] : [];
    });
    const handoff = sections
      .map(({ change, printed }) =>
        changes.length > 1 ? `${change}:\n${printed.handoff}` : printed.handoff,
      )
      .join("\n\n");
    if (!handoff) return PASS;
    const written = writtenSection(await response());
    const missing = written === null ? [] : missingActions(sections, written);
    const extra = written === null ? [] : extraActions(workflow, sections, written);
    if (written !== null && missing.length === 0 && extra.length === 0) return PASS;
    if (again) return { kind: "notice", text: `Mate hand-off:\n\n${handoff}` };
    const named = (actions: Step[]) =>
      actions.map((action) => formatInvocation(runtime, action.skill, action.change)).join(", ");
    const faults = [
      ...(missing.length > 0 ? [`lacks ${named(missing)}`] : []),
      ...(extra.length > 0 ? [`lists ${named(extra)}, which Mate did not print`] : []),
    ];
    const ask =
      written === null
        ? "End your response with a final `## Next steps` section"
        : `Your \`## Next steps\` section ${faults.join(" and ")}. Rewrite it as the final section`;
    return {
      kind: "sendBack",
      reason: `${ask}: required work of this run that is still open first, then exactly these actions in order, no other step of the Delivery Path, swapping only the skill prefix for your runtime; optional work goes above it, labelled optional. Run none of them.\n\n${handoff}`,
    };
  }

  const step = turn.step;
  // A Mate stage skill reports itself when it finishes; without a report it waits for the user.
  if (again || !step || !companionStep(workflow, step.skill) || next(step.change) === null) {
    return PASS;
  }
  return {
    kind: "sendBack",
    reason: `${formatInvocation(runtime, step.skill)} is a step of the Delivery Path. If it has finished for ${step.change}, run \`mate workflow done ${step.skill} "${step.change}"\` and end your response with a final \`## Next steps\` section listing the actions it prints, running none of them. If it is waiting for the user, stop as you are.`,
  };
}
