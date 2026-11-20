import type { FrictionReport } from "../../../runtime/friction-log";
import { FRICTION_RETENTION_DAYS } from "../../../runtime/friction-retention";
import type { FrictionState, SubjectType } from "../../../runtime/friction-vocabulary";

// Free of node imports: Studio's client imports this file.

export const FRICTION_VIEW_DAYS = [7, 30, FRICTION_RETENTION_DAYS] as const;
export type FrictionViewDays = (typeof FRICTION_VIEW_DAYS)[number];

/** The period a value names, as a number or its text; `undefined` for any other. */
export function frictionViewDays(value: unknown): FrictionViewDays | undefined {
  return FRICTION_VIEW_DAYS.find((days) => String(days) === String(value));
}

/** A fingerprint's Friction State with what later events tell about it, derived on read. */
export interface FrictionGroupState extends FrictionState {
  /** Events of the period later than the mark. */
  eventsSince: number;
  /** `fixed`, yet recorded again after the mark. */
  reopened: boolean;
}

/** Either item's state: a group's carries `eventsSince` and `reopened`. */
export type FrictionItemState = FrictionState &
  Partial<Pick<FrictionGroupState, "eventsSince" | "reopened">>;

export interface FrictionGroup {
  fingerprint: string;
  /** The fingerprint as a plain sentence. */
  title: string;
  /** The subject type a report on its events takes: `hook` for a refusal, `command` otherwise. */
  subjectType: SubjectType;
  events: number;
  sessions: number;
  /** The highest event count within one session. */
  maxPerSession: number;
  firstSeen: string;
  lastSeen: string;
  /** Mate version → event count. */
  versions: Record<string, number>;
  /** Companion path → event count. */
  companions: Record<string, number>;
  /** Path a refused call named → event count. */
  paths: Record<string, number>;
  /** Flag a failed command carried → event count. */
  flags: Record<string, number>;
  /** Reports on the group's events, newest first. */
  reports: FrictionReport[];
  state: FrictionGroupState | null;
  /** Unmarked or reopened. */
  open: boolean;
}

export interface FrictionFreeReport extends FrictionReport {
  /** `null` for a subject of no known type. */
  subjectType: SubjectType | null;
  state: FrictionState | null;
  open: boolean;
}

/** The Friction View of a scope and period; `mate friction list --json` and Studio carry it. */
export interface FrictionView {
  /** Whether the Friction Switch is on. */
  recording: boolean;
  days: number;
  events: number;
  sessions: number;
  /** Most repeated within one session first, then by event count. */
  groups: FrictionGroup[];
  /** Newest first. */
  freeReports: FrictionFreeReport[];
}
