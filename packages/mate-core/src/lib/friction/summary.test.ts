import { describe, expect, test } from "bun:test";

import type { FrictionEvent, FrictionReport } from "../../runtime/friction-log";
import type { FrictionState } from "../../runtime/friction-vocabulary";
import { selectByState } from "./select";
import { summarizeFriction } from "./summary";

const MARKED_AT = "2027-03-10T12:00:00.000Z";

function event(fingerprint: string, at: string): FrictionEvent {
  return {
    v: 1,
    id: crypto.randomUUID(),
    at,
    kind: "refusal",
    fingerprint,
    mateVersion: "1.0.0",
    runtime: "claude",
    sessionId: "s",
    companion: "/acme",
    repositoryPath: null,
    detail: {},
  };
}

function freeReport(id: string): FrictionReport {
  return {
    v: 1,
    id,
    at: MARKED_AT,
    eventId: null,
    kind: "unclear",
    cost: null,
    subject: "docs:acme",
    expected: "x",
    evidence: "y",
    workaround: null,
    mateVersion: "1.0.0",
    companion: "/acme",
    sessionId: null,
    runtime: null,
  };
}

const marked = (state: FrictionState["state"], link: string | null = null): FrictionState => ({
  state,
  at: MARKED_AT,
  by: "person",
  note: null,
  link,
});

const before = "2027-03-09T12:00:00.000Z";
const after = "2027-03-11T12:00:00.000Z";

describe("summarizeFriction with Friction States", () => {
  test("a fixed fingerprint with a later event is reopened and open", () => {
    const summary = summarizeFriction(
      [event("command:acme:1", before), event("command:acme:1", after)],
      [],
      { fingerprints: { "command:acme:1": marked("fixed") }, reports: {} },
    );

    expect(summary.groups[0]).toMatchObject({
      state: { state: "fixed", eventsSince: 1, reopened: true },
      open: true,
    });
  });

  test("a reported fingerprint stays handled and counts the events since", () => {
    const summary = summarizeFriction(
      [event("command:acme:1", before), ...[1, 2, 3].map(() => event("command:acme:1", after))],
      [],
      {
        fingerprints: { "command:acme:1": marked("reported", "https://acme.test/7") },
        reports: {},
      },
    );

    expect(summary.groups[0]).toMatchObject({
      state: { state: "reported", link: "https://acme.test/7", eventsSince: 3, reopened: false },
      open: false,
    });
  });

  test("a dismissed fingerprint stays dismissed whatever is recorded later", () => {
    const summary = summarizeFriction([event("command:acme:1", after)], [], {
      fingerprints: { "command:acme:1": marked("dismissed") },
      reports: {},
    });

    expect(summary.groups[0]).toMatchObject({ state: { reopened: false }, open: false });
  });

  test("a state whose target has no record in the window adds nothing", () => {
    const summary = summarizeFriction([event("command:acme:1", before)], [], {
      fingerprints: { "refusal:secret:read": marked("fixed") },
      reports: { gone: marked("dismissed") },
    });

    expect(summary.groups.map((group) => group.fingerprint)).toEqual(["command:acme:1"]);
    expect(summary.groups[0]).toMatchObject({ state: null, open: true });
    expect(summary.freeReports).toEqual([]);
  });

  test("a Free Report carries its state", () => {
    const summary = summarizeFriction([], [freeReport("r1"), freeReport("r2")], {
      fingerprints: {},
      reports: { r1: marked("dismissed") },
    });

    expect(
      summary.freeReports.map(({ id, open, state }) => ({ id, open, state: state?.state })),
    ).toEqual(
      expect.arrayContaining([
        { id: "r1", open: false, state: "dismissed" },
        { id: "r2", open: true, state: undefined },
      ]),
    );
  });
});

describe("selectByState", () => {
  const summary = summarizeFriction(
    [event("command:acme:1", before), event("refusal:secret:read", before)],
    [freeReport("r1")],
    { fingerprints: { "command:acme:1": marked("fixed") }, reports: {} },
  );

  test.each([
    ["open", ["refusal:secret:read"], ["r1"], 1],
    ["handled", ["command:acme:1"], [], 2],
    ["all", ["command:acme:1", "refusal:secret:read"], ["r1"], 0],
  ] as const)(
    "%s shows its items and counts the hidden ones",
    (filter, groups, reports, hidden) => {
      const selection = selectByState(summary, filter);

      expect(selection.groups.map((group) => group.fingerprint).toSorted()).toEqual([...groups]);
      expect(selection.freeReports.map((report) => report.id)).toEqual([...reports]);
      expect(selection.hidden).toBe(hidden);
    },
  );
});
