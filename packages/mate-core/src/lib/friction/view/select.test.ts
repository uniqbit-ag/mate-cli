import { describe, expect, test } from "bun:test";

import type { FrictionFreeReport, FrictionGroup, FrictionGroupState } from "./model";
import { selectFriction, type FrictionFilters } from "./select";

const OPEN: FrictionFilters = { state: "open" };

function group(fields: Partial<FrictionGroup> = {}): FrictionGroup {
  return {
    fingerprint: "refusal:artifact:write",
    title: "The artifact check refused a file write",
    subjectType: "hook",
    events: 1,
    sessions: 1,
    maxPerSession: 1,
    firstSeen: "2027-03-10T12:00:00.000Z",
    lastSeen: "2027-03-10T12:00:00.000Z",
    versions: {},
    companions: {},
    paths: {},
    flags: {},
    reports: [],
    state: null,
    open: true,
    ...fields,
  };
}

function freeReport(fields: Partial<FrictionFreeReport> = {}): FrictionFreeReport {
  return {
    v: 1,
    id: "r1",
    at: "2027-03-10T12:00:00.000Z",
    eventId: null,
    kind: "bug",
    cost: null,
    subject: "skill:acme",
    subjectType: "skill",
    expected: "x",
    evidence: "y",
    workaround: null,
    mateVersion: "1.0.0",
    companion: "/acme",
    sessionId: null,
    runtime: null,
    state: null,
    open: true,
    ...fields,
  };
}

const fixed: FrictionGroupState = {
  state: "fixed",
  at: "2027-03-10T12:00:00.000Z",
  by: "person",
  note: null,
  link: null,
  eventsSince: 0,
  reopened: false,
};

const fingerprints = (shown: ReturnType<typeof selectFriction>) =>
  shown.groups.map((item) => item.fingerprint);
const reportIds = (shown: ReturnType<typeof selectFriction>) =>
  shown.freeReports.map((report) => report.id);

describe("the state filter", () => {
  const view = {
    groups: [
      group({ fingerprint: "command:acme:1", subjectType: "command", state: fixed, open: false }),
      group(),
    ],
    freeReports: [freeReport()],
  };

  test.each([
    ["open", ["refusal:artifact:write"], ["r1"], 1],
    ["handled", ["command:acme:1"], [], 2],
    ["all", ["command:acme:1", "refusal:artifact:write"], ["r1"], 0],
  ] as const)("%s shows its items and counts the hidden ones", (state, groups, reports, hidden) => {
    const shown = selectFriction(view, { state });
    expect(fingerprints(shown)).toEqual([...groups]);
    expect(reportIds(shown)).toEqual([...reports]);
    expect(shown.hidden).toBe(hidden);
  });
});

describe("the type and kind filters", () => {
  const view = {
    groups: [group({ fingerprint: "command:acme:1", subjectType: "command" })],
    freeReports: [
      freeReport({ id: "r-skill" }),
      freeReport({
        id: "r-command",
        subject: "command:acme",
        subjectType: "command",
        kind: "unclear",
      }),
    ],
  };

  test("offers each type present in the period, in vocabulary order", () => {
    expect(selectFriction(view, OPEN).types).toEqual(["command", "skill"]);
  });

  test("a type shared by groups and Free Reports shows both of that type", () => {
    const shown = selectFriction(view, { ...OPEN, type: "command" });
    expect(fingerprints(shown)).toEqual(["command:acme:1"]);
    expect(reportIds(shown)).toEqual(["r-command"]);
    expect(shown.hidden).toBe(1);
  });

  test("a type absent from the period reads as every type", () => {
    const shown = selectFriction(view, { ...OPEN, type: "docs" });
    expect(shown.type).toBeUndefined();
    expect(shown.hidden).toBe(0);
  });

  test("a kind narrows Free Reports and leaves groups unchanged", () => {
    const shown = selectFriction(view, { ...OPEN, kind: "bug" });
    expect(reportIds(shown)).toEqual(["r-skill"]);
    expect(fingerprints(shown)).toEqual(["command:acme:1"]);
  });
});
