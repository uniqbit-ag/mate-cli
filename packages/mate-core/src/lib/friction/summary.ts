import {
  readFriction,
  type FrictionEvent,
  type FrictionReport,
  type FrictionScope,
} from "../../runtime/friction-log";
import { readFrictionStates, type FrictionStatesFile } from "../../runtime/friction-state";
import type { FrictionState } from "../../runtime/friction-vocabulary";

/** A group's Friction State with what later events tell about it, derived on read. */
export interface FrictionGroupState extends FrictionState {
  /** Events of the window later than the mark. */
  eventsSince: number;
  /** `fixed`, yet recorded again after the mark. */
  reopened: boolean;
}

export interface FrictionGroup {
  fingerprint: string;
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
  state: FrictionState | null;
  open: boolean;
}

export interface FrictionSummary {
  events: number;
  sessions: number;
  groups: FrictionGroup[];
  /** Reports on no event, newest first. */
  freeReports: FrictionFreeReport[];
}

const newestFirst = (reports: FrictionReport[]) =>
  reports.toSorted((a, b) => b.at.localeCompare(a.at));

/** The fields inside `detail` are not validated on read. */
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Counts each name once per event. */
function tally(counts: Record<string, number>, names: string[]): void {
  for (const name of new Set(names)) counts[name] = (counts[name] ?? 0) + 1;
}

function groupState(state: FrictionState | undefined, times: string[]): FrictionGroupState | null {
  if (!state) return null;
  const markedAt = Date.parse(state.at);
  const eventsSince = times.filter((at) => Date.parse(at) > markedAt).length;
  return { ...state, eventsSince, reopened: state.state === "fixed" && eventsSince > 0 };
}

/** Grouped by fingerprint; repeats within one session rank first, then the event count. */
export function summarizeFriction(
  events: FrictionEvent[],
  reports: FrictionReport[],
  states: Pick<FrictionStatesFile, "fingerprints" | "reports"> = { fingerprints: {}, reports: {} },
): FrictionSummary {
  const reportsByEvent = Map.groupBy(
    reports.filter((report) => report.eventId),
    (report) => report.eventId,
  );
  const byFingerprint = Map.groupBy(events, (event) => event.fingerprint);
  const groups = [...byFingerprint].map(([fingerprint, grouped]): FrictionGroup => {
    const perSession = new Map<string, number>();
    const versions: Record<string, number> = {};
    const companions: Record<string, number> = {};
    const paths: Record<string, number> = {};
    const flags: Record<string, number> = {};
    for (const event of grouped) {
      perSession.set(event.sessionId, (perSession.get(event.sessionId) ?? 0) + 1);
      versions[event.mateVersion] = (versions[event.mateVersion] ?? 0) + 1;
      companions[event.companion] = (companions[event.companion] ?? 0) + 1;
      tally(paths, strings(event.detail.paths));
      tally(flags, strings(event.detail.flags));
    }
    const times = grouped.map((event) => event.at).toSorted();
    const state = groupState(states.fingerprints[fingerprint], times);
    return {
      fingerprint,
      events: grouped.length,
      sessions: perSession.size,
      maxPerSession: Math.max(...perSession.values()),
      firstSeen: times[0],
      lastSeen: times[times.length - 1],
      versions,
      companions,
      paths,
      flags,
      reports: newestFirst(grouped.flatMap((event) => reportsByEvent.get(event.id) ?? [])),
      state,
      open: state === null || state.reopened,
    };
  });
  groups.sort((a, b) => b.maxPerSession - a.maxPerSession || b.events - a.events);
  return {
    events: events.length,
    sessions: new Set(events.map((event) => event.sessionId)).size,
    groups,
    freeReports: newestFirst(reports.filter((report) => !report.eventId)).map((report) => {
      const state = states.reports[report.id] ?? null;
      return { ...report, state, open: state === null };
    }),
  };
}

export interface FrictionWindow {
  days: number;
  homeDir?: string;
  now?: Date;
}

export function readFrictionSummary(scope: FrictionScope, window: FrictionWindow): FrictionSummary {
  const { events, reports } = readFriction(scope, {
    sinceDays: window.days,
    homeDir: window.homeDir,
    now: window.now,
  });
  return summarizeFriction(events, reports, readFrictionStates(window.homeDir));
}
