import { describe, expect, test } from "bun:test";

import { frictionFixture, frictionFreeReport, frictionGroup, frictionState } from "./fixture";
import { type FrictionFilters, selectFriction } from "./select-friction";

const DEFAULTS: FrictionFilters = { state: "open", sort: "repeats" };
const COMMAND_GROUP = frictionGroup({
  fingerprint: "command:artifact archive:1",
  subjectType: "command",
  lastSeen: "2026-11-12T09:00:00Z",
  maxPerSession: 1,
});
const SKILL_REPORT = frictionFreeReport({ id: "r-skill", subject: "skill:mate-apply-change" });
const COMMAND_REPORT = frictionFreeReport({
  id: "r-command",
  subject: "command:artifact-submit",
  kind: "unclear",
});

const fingerprints = (shown: ReturnType<typeof selectFriction>) =>
  shown.groups.map((group) => group.fingerprint);
const reportIds = (shown: ReturnType<typeof selectFriction>) =>
  shown.freeReports.map((report) => report.id);

describe("the state filter", () => {
  test("a fixed group leaves the default view until Handled or All", () => {
    const view = frictionFixture({
      groups: [frictionGroup({ state: frictionState(), open: false }), COMMAND_GROUP],
    });
    expect(fingerprints(selectFriction(view, DEFAULTS))).toEqual([COMMAND_GROUP.fingerprint]);
    expect(fingerprints(selectFriction(view, { ...DEFAULTS, state: "handled" }))).toEqual([
      "refusal:artifact:write",
    ]);
    expect(selectFriction(view, { ...DEFAULTS, state: "all" }).groups).toHaveLength(2);
  });

  test("a reopened group is open", () => {
    const reopened = frictionGroup({
      state: frictionState({ eventsSince: 1, reopened: true }),
      open: true,
    });
    const view = frictionFixture({ groups: [reopened] });
    expect(selectFriction(view, DEFAULTS).groups).toEqual([reopened]);
    expect(selectFriction(view, { ...DEFAULTS, state: "handled" }).groups).toEqual([]);
  });

  test("applies to Agent reports too", () => {
    const dismissed = frictionFreeReport({
      id: "r-dismissed",
      state: {
        state: "dismissed",
        at: "2026-11-10T10:00:00Z",
        by: "studio",
        note: null,
        link: null,
      },
      open: false,
    });
    const view = frictionFixture({ freeReports: [dismissed, SKILL_REPORT] });
    expect(reportIds(selectFriction(view, DEFAULTS))).toEqual(["r-skill"]);
    expect(reportIds(selectFriction(view, { ...DEFAULTS, state: "handled" }))).toEqual([
      "r-dismissed",
    ]);
  });
});

describe("the type and kind filters", () => {
  const view = frictionFixture({
    groups: [COMMAND_GROUP],
    freeReports: [SKILL_REPORT, COMMAND_REPORT],
  });

  test("offers each type present in the period, in vocabulary order", () => {
    expect(selectFriction(view, DEFAULTS).types).toEqual(["command", "skill"]);
  });

  test("only skills shows only the skill report", () => {
    const shown = selectFriction(view, { ...DEFAULTS, type: "skill" });
    expect(shown.groups).toEqual([]);
    expect(reportIds(shown)).toEqual(["r-skill"]);
  });

  test("a type shared by both sections shows the groups and the reports of that type", () => {
    const shown = selectFriction(view, { ...DEFAULTS, type: "command" });
    expect(fingerprints(shown)).toEqual([COMMAND_GROUP.fingerprint]);
    expect(reportIds(shown)).toEqual(["r-command"]);
  });

  test("a type absent from the period reads as All", () => {
    const shown = selectFriction(view, { ...DEFAULTS, type: "docs" });
    expect(shown.type).toBeUndefined();
    expect(shown.hidden).toBe(0);
  });

  test("only bugs narrows the Agent reports and leaves recorded friction unchanged", () => {
    const shown = selectFriction(view, { ...DEFAULTS, kind: "bug" });
    expect(reportIds(shown)).toEqual(["r-skill"]);
    expect(fingerprints(shown)).toEqual([COMMAND_GROUP.fingerprint]);
  });
});

describe("the order", () => {
  const repeated = frictionGroup({ maxPerSession: 4, lastSeen: "2026-11-03T09:00:00Z" });
  const recent = frictionGroup({
    fingerprint: "refusal:acme:today",
    maxPerSession: 1,
    lastSeen: "2026-11-10T09:00:00Z",
  });
  const view = frictionFixture({ groups: [repeated, recent] });

  test("most repeated in one session keeps the summary's order", () => {
    expect(selectFriction(view, DEFAULTS).groups).toEqual([repeated, recent]);
  });

  test("most recent puts the group last seen today first", () => {
    expect(selectFriction(view, { ...DEFAULTS, sort: "recent" }).groups).toEqual([
      recent,
      repeated,
    ]);
  });
});

test("counts the items the filters hide", () => {
  const view = frictionFixture({
    groups: [
      frictionGroup(),
      frictionGroup({ fingerprint: "b" }),
      frictionGroup({
        fingerprint: "c",
        state: frictionState({ state: "dismissed" }),
        open: false,
      }),
    ],
  });
  const shown = selectFriction(view, DEFAULTS);
  expect(shown.groups).toHaveLength(2);
  expect(shown.hidden).toBe(1);
});
