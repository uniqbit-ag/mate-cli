import {
  subjectTypeOf,
  type FrictionFreeReport,
  type FrictionGroupState,
  type FrictionReport,
  type FrictionView,
  type FrictionGroup,
} from "@uniqbit/mate-core/studio";

const COMPANION = "/home/dev/.mate/companions/acme-companion";

export function frictionReport(fields: Partial<FrictionReport> = {}): FrictionReport {
  return {
    v: 1,
    id: "r1",
    at: "2026-11-10T09:30:00Z",
    eventId: "e1",
    kind: "bug",
    cost: "detour",
    subject: "hook:artifact",
    expected: "editing a tracked Markdown file is allowed",
    evidence: null,
    workaround: null,
    mateVersion: "1.0.0",
    companion: COMPANION,
    sessionId: "s1",
    runtime: "claude",
    ...fields,
  };
}

export function frictionFreeReport(fields: Partial<FrictionFreeReport> = {}): FrictionFreeReport {
  const report = frictionReport({ eventId: null, ...fields });
  return {
    subjectType: subjectTypeOf(report.subject),
    state: null,
    open: true,
    ...report,
    ...fields,
  };
}

export function frictionState(fields: Partial<FrictionGroupState> = {}): FrictionGroupState {
  return {
    state: "fixed",
    at: "2026-11-10T10:00:00Z",
    by: "person",
    note: null,
    link: null,
    eventsSince: 0,
    reopened: false,
    ...fields,
  };
}

export function frictionGroup(fields: Partial<FrictionGroup> = {}): FrictionGroup {
  return {
    fingerprint: "refusal:artifact:write",
    title: "The artifact check refused a file write",
    subjectType: "hook",
    events: 5,
    sessions: 2,
    maxPerSession: 3,
    firstSeen: "2026-11-09T08:00:00Z",
    lastSeen: "2026-11-10T09:00:00Z",
    versions: { "1.0.0": 5 },
    companions: { [COMPANION]: 5 },
    paths: { "notes.md": 2 },
    flags: {},
    reports: [],
    state: null,
    open: true,
    ...fields,
  };
}

export function frictionFixture(fields: Partial<FrictionView> = {}): FrictionView {
  return {
    recording: true,
    days: 30,
    events: 6,
    sessions: 3,
    groups: [
      frictionGroup(),
      frictionGroup({
        fingerprint: "command:artifact archive:1",
        title: "mate artifact archive failed with exit code 1",
        subjectType: "command",
        events: 1,
        sessions: 1,
        maxPerSession: 1,
        paths: {},
        flags: { "--json": 1 },
      }),
    ],
    freeReports: [],
    ...fields,
  };
}
