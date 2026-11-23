import { formatInvocation, type AgentRuntime } from "../../runtime/skill-prefix";

/**
 * The hand-off `mate workflow done` prints after every reported step: what the developer starts
 * next, a later step of the same stage or the stage the change is then at, so an open earlier
 * stage comes first. A session never runs what it lists. The Path Position builds it as data;
 * the `## Next steps` section and the `next:` lines are renderings of it in the runtime's skill
 * syntax.
 */

/** A skill to run; `note` says what is open, `afterReview` that it follows the listed reviews. */
export interface SkillAction {
  kind: "skill";
  skill: string;
  change?: string;
  note?: string;
  afterReview?: true;
}

/** A step outside any skill: a merge or a review. */
export interface TextAction {
  kind: "text";
  text: string;
}

export type HandoffAction = SkillAction | TextAction;

export interface Handoff {
  /** In order; empty when nothing follows. */
  actions: HandoffAction[];
  /** The optional skill stages offered beside them. */
  optional: SkillAction[];
  /** Steps counted as done without a report, in Delivery Path order. */
  counted: SkillAction[];
}

function renderAction(action: HandoffAction, runtime: AgentRuntime): string {
  if (action.kind === "text") return action.text;
  const invocation = formatInvocation(runtime, action.skill, action.change);
  return `${action.afterReview ? "After your review: " : ""}${invocation}${action.note ? ` (${action.note})` : ""}`;
}

const invocations = (actions: readonly SkillAction[], runtime: AgentRuntime): string =>
  actions.map((action) => renderAction(action, runtime)).join(", ");

function countedLine(counted: readonly SkillAction[], runtime: AgentRuntime): string[] {
  if (counted.length === 0) return [];
  // Said outright: a session otherwise lists a counted step as the first action.
  const note =
    counted.length > 1
      ? "Not actions below; run each if it did not run."
      : "Not an action below; run it if it did not run.";
  return [`Counted, not reported: ${invocations(counted, runtime)}. ${note}`];
}

/** The `## Next steps` section, the counted and optional lines above it; empty when nothing follows. */
export function renderHandoff(handoff: Handoff, runtime: AgentRuntime): string {
  if (handoff.actions.length === 0) return "";
  const { optional } = handoff;
  const above = [
    ...countedLine(handoff.counted, runtime),
    ...(optional.length === 0
      ? []
      : [
          `Optional${optional.length > 1 ? ", any order" : ""}: ${invocations(optional, runtime)}.`,
        ]),
  ];
  return [
    ...above,
    ...(above.length > 0 ? [""] : []),
    "## Next steps",
    ...handoff.actions.map((action, index) => `${index + 1}. ${renderAction(action, runtime)}`),
  ].join("\n");
}

/**
 * The hand-off as bare data for a session: one `next:` line per action, in order, then one
 * `optional:` line, then the counted steps' line as the section words it. No heading and no
 * instruction: a heading made the output read like a finished answer, which sessions
 * paraphrased; the skill says how to end the response, and the model writes the section from
 * these lines.
 */
export function handoffLines(handoff: Handoff, runtime: AgentRuntime): string[] {
  const { optional } = handoff;
  return [
    ...handoff.actions.map((action) => `next: ${renderAction(action, runtime)}`),
    ...(optional.length === 0 ? [] : [`optional: ${invocations(optional, runtime)}.`]),
    ...countedLine(handoff.counted, runtime),
  ];
}
