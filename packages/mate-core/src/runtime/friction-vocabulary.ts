/** Friction names shared with Studio's client; free of node imports. */

export const REPORT_KINDS = ["bug", "unclear", "missing"] as const;
export const REPORT_COSTS = ["blocker", "detour", "papercut"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export type ReportCost = (typeof REPORT_COSTS)[number];

export const SUBJECT_TYPES = [
  "command",
  "hook",
  "skill",
  "guidance",
  "capability",
  "docs",
] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

/** The type a subject names before its first `:`; `null` for none of {@link SUBJECT_TYPES}. */
export function subjectTypeOf(subject: string): SubjectType | null {
  const type = subject.split(":", 1)[0];
  return SUBJECT_TYPES.find((known) => known === type) ?? null;
}

/** A Friction State; a target without one is `open`. */
export const FRICTION_STATES = ["fixed", "reported", "dismissed"] as const;
export type FrictionStateName = (typeof FRICTION_STATES)[number];
/** What a mark may set; `open` clears the Friction State. */
export const MARK_STATES = ["open", ...FRICTION_STATES] as const;
export type MarkState = (typeof MARK_STATES)[number];

export const FRICTION_STATE_ORIGINS = ["person", "triage", "studio"] as const;
export type FrictionStateOrigin = (typeof FRICTION_STATE_ORIGINS)[number];

export const STATE_FILTERS = ["open", "handled", "all"] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

export interface FrictionState {
  state: FrictionStateName;
  /** ISO 8601 UTC. */
  at: string;
  by: FrictionStateOrigin;
  note: string | null;
  link: string | null;
}
