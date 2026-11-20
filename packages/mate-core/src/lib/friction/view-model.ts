import { FRICTION_RETENTION_DAYS } from "../../runtime/friction-retention";
import type { SubjectType } from "../../runtime/friction-vocabulary";
import type { FrictionGroup, FrictionSummary } from "./summary";

export const FRICTION_VIEW_DAYS = [7, 30, FRICTION_RETENTION_DAYS] as const;
export type FrictionViewDays = (typeof FRICTION_VIEW_DAYS)[number];

/** The period a value names, as a number or its text; `undefined` for any other. */
export function frictionViewDays(value: unknown): FrictionViewDays | undefined {
  return FRICTION_VIEW_DAYS.find((days) => String(days) === String(value));
}

export interface FrictionViewGroup extends FrictionGroup {
  /** The fingerprint as a plain sentence. */
  title: string;
  /** The subject type a report on its events takes: `hook` for a refusal, `command` otherwise. */
  subjectType: SubjectType;
}

/** What `mate friction list --json` carries for one companion, with sentences and the switch. */
export interface FrictionView extends Omit<FrictionSummary, "groups"> {
  recording: boolean;
  days: number;
  groups: FrictionViewGroup[];
}
