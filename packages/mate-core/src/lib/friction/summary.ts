import {
  readFriction,
  type FrictionEvent,
  type FrictionReport,
  type FrictionScope,
} from "../../runtime/friction-log";

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
}

export interface FrictionSummary {
  events: number;
  sessions: number;
  groups: FrictionGroup[];
  /** Reports on no event, newest first. */
  freeReports: FrictionReport[];
}

const newestFirst = (reports: FrictionReport[]) =>
  reports.toSorted((a, b) => b.at.localeCompare(a.at));

/** `detail` is not validated on read. */
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Counts each name once per event. */
function tally(counts: Record<string, number>, names: string[]): void {
  for (const name of new Set(names)) counts[name] = (counts[name] ?? 0) + 1;
}

/** Grouped by fingerprint; repeats within one session rank first, then the event count. */
export function summarizeFriction(
  events: FrictionEvent[],
  reports: FrictionReport[],
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
    };
  });
  groups.sort((a, b) => b.maxPerSession - a.maxPerSession || b.events - a.events);
  return {
    events: events.length,
    sessions: new Set(events.map((event) => event.sessionId)).size,
    groups,
    freeReports: newestFirst(reports.filter((report) => !report.eventId)),
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
  return summarizeFriction(events, reports);
}
