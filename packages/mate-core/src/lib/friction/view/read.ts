import {
  readFriction,
  type FrictionEvent,
  type FrictionReport,
  type FrictionScope,
} from "../../../runtime/friction-log";
import { readFrictionStates } from "../../../runtime/friction-state";
import { readFrictionSwitch } from "../../../runtime/friction-switch";
import { subjectTypeOf, type FrictionState } from "../../../runtime/friction-vocabulary";
import { describeFingerprint } from "../describe";
import { eventSubjectType } from "../fields";
import type { FrictionGroup, FrictionGroupState, FrictionView } from "./model";

// The one reader that joins the Friction Log with the Friction States (ADR-026); reads only.

interface FrictionWindow {
  days: number;
  homeDir?: string;
  now?: Date;
}

export interface FrictionRecords {
  events: FrictionEvent[];
  /** The reports on those events wherever they were made, and the scope's Free Reports. */
  reports: FrictionReport[];
  /** The Friction States of the fingerprints and Free Reports in the records, and no other. */
  states: {
    fingerprints: Record<string, FrictionGroupState>;
    reports: Record<string, FrictionState>;
  };
}

function groupState(state: FrictionState, times: string[]): FrictionGroupState {
  const markedAt = Date.parse(state.at);
  const eventsSince = times.filter((at) => Date.parse(at) > markedAt).length;
  return { ...state, eventsSince, reopened: state.state === "fixed" && eventsSince > 0 };
}

const byFingerprint = (events: FrictionEvent[]) =>
  Map.groupBy(events, (event) => event.fingerprint);

export function readFrictionRecords(scope: FrictionScope, window: FrictionWindow): FrictionRecords {
  const { events, reports } = readFriction(scope, {
    sinceDays: window.days,
    homeDir: window.homeDir,
    now: window.now,
  });
  const stored = readFrictionStates(window.homeDir);
  const fingerprints: Record<string, FrictionGroupState> = {};
  for (const [fingerprint, grouped] of byFingerprint(events)) {
    const state = stored.fingerprints[fingerprint];
    if (state) {
      fingerprints[fingerprint] = groupState(
        state,
        grouped.map((event) => event.at),
      );
    }
  }
  const freeStates: Record<string, FrictionState> = {};
  for (const report of reports) {
    const state = report.eventId ? undefined : stored.reports[report.id];
    if (state) freeStates[report.id] = state;
  }
  return { events, reports, states: { fingerprints, reports: freeStates } };
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

function toGroup(
  fingerprint: string,
  grouped: FrictionEvent[],
  reportsByEvent: Map<string | null, FrictionReport[]>,
  state: FrictionGroupState | undefined,
): FrictionGroup {
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
  return {
    fingerprint,
    title: describeFingerprint(fingerprint),
    subjectType: eventSubjectType({ fingerprint }),
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
    state: state ?? null,
    open: !state || state.reopened,
  };
}

export function readFrictionView(scope: FrictionScope, window: FrictionWindow): FrictionView {
  const { events, reports, states } = readFrictionRecords(scope, window);
  const reportsByEvent = Map.groupBy(
    reports.filter((report) => report.eventId),
    (report) => report.eventId,
  );
  const groups = [...byFingerprint(events)].map(([fingerprint, grouped]) =>
    toGroup(fingerprint, grouped, reportsByEvent, states.fingerprints[fingerprint]),
  );
  groups.sort((a, b) => b.maxPerSession - a.maxPerSession || b.events - a.events);
  return {
    recording: readFrictionSwitch(window.homeDir),
    days: window.days,
    events: events.length,
    sessions: new Set(events.map((event) => event.sessionId)).size,
    groups,
    freeReports: newestFirst(reports.filter((report) => !report.eventId)).map((report) => {
      const state = states.reports[report.id] ?? null;
      return { ...report, subjectType: subjectTypeOf(report.subject), state, open: !state };
    }),
  };
}
