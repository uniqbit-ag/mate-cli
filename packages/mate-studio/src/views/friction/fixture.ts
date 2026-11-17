import type { FrictionReport, FrictionView, FrictionViewGroup } from "@uniqbit/mate-core/studio";

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

export function frictionGroup(fields: Partial<FrictionViewGroup> = {}): FrictionViewGroup {
  return {
    fingerprint: "refusal:artifact:write",
    title: "The artifact check refused a file write",
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
    ...fields,
  };
}

/** Synthetic friction for component tests; never reads the Friction Log. */
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
