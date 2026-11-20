import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  appendEvent,
  appendReport,
  frictionLogDir,
  type NewFrictionEvent,
} from "../../../runtime/friction-log";
import { updateFrictionStates } from "../../../runtime/friction-state";
import { writeFrictionSwitch } from "../../../runtime/friction-switch";
import type { FrictionState } from "../../../runtime/friction-vocabulary";
import { readFrictionRecords, readFrictionView } from "./read";

const COMPANION = "/acme/companion";
const now = new Date("2027-03-14T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
/** Three days ago: between `record`'s default of one day and five days ago. */
const MARKED_AT = new Date(now.getTime() - 3 * DAY_MS).toISOString();
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mate-friction-view-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function record(overrides: Partial<NewFrictionEvent> = {}, daysAgo = 1) {
  return appendEvent(
    {
      kind: "refusal",
      fingerprint: "refusal:artifact:write",
      mateVersion: "1.0.0",
      runtime: "claude",
      sessionId: "s1",
      companion: COMPANION,
      repositoryPath: null,
      detail: {},
      ...overrides,
    },
    { homeDir: home, now: new Date(now.getTime() - daysAgo * DAY_MS) },
  )!;
}

function freeReport(subject = "docs:acme", companion = COMPANION) {
  return appendReport(
    {
      eventId: null,
      kind: "unclear",
      cost: null,
      subject,
      expected: "x",
      evidence: "y",
      workaround: null,
      mateVersion: "1.0.0",
      companion,
      sessionId: null,
      runtime: null,
    },
    { homeDir: home, now: new Date(now.getTime() - DAY_MS) },
  );
}

const marked = (state: FrictionState["state"], link: string | null = null): FrictionState => ({
  state,
  at: MARKED_AT,
  by: "person",
  note: null,
  link,
});

async function mark(family: "fingerprints" | "reports", target: string, state: FrictionState) {
  await updateFrictionStates(
    (states) => {
      states[family][target] = state;
    },
    { homeDir: home },
  );
}

const window = (days = 30) => ({ days, homeDir: home, now });
const view = (days?: number) => readFrictionView({ companion: COMPANION }, window(days));

test("shows the selected companion's events within the period, each group with a sentence", () => {
  record({ detail: { paths: ["notes.md"] } });
  record({ companion: "/acme/other" });
  record({}, 9);

  expect(view(7)).toMatchObject({
    days: 7,
    events: 1,
    groups: [{ title: "The artifact check refused a file write", paths: { "notes.md": 1 } }],
  });
  expect(view(30).events).toBe(2);
});

test("a refusal group takes the subject type hook, a failed command group command", () => {
  record();
  record({ kind: "command-failure", fingerprint: "command:artifact archive:1" });
  const types = Object.fromEntries(
    view().groups.map((group) => [group.fingerprint, group.subjectType]),
  );
  expect(types).toEqual({
    "refusal:artifact:write": "hook",
    "command:artifact archive:1": "command",
  });
});

test("a Free Report carries the type its subject names, or null for none known", () => {
  freeReport("skill:acme");
  freeReport("acme:thing");
  const types = view().freeReports.map((report) => report.subjectType);
  expect(types).toHaveLength(2);
  expect(types).toEqual(expect.arrayContaining(["skill", null]));
});

test("carries the switch state", () => {
  expect(view().recording).toBe(false);
  writeFrictionSwitch(true, home);
  expect(view().recording).toBe(true);
});

test("returns no refusal message, command text or error text of an event", () => {
  record({
    detail: { message: "acme refusal message", command: "acme command", error: "acme error" },
  });
  expect(JSON.stringify(view())).not.toContain("acme ");
});

test("a read creates no file or folder", () => {
  view();
  readFrictionRecords({ companion: COMPANION }, window());
  expect(fs.existsSync(frictionLogDir(home))).toBe(false);
  expect(fs.readdirSync(home)).toEqual([]);
});

describe("joined with the Friction States", () => {
  test("a fixed fingerprint with a later event is reopened and open", async () => {
    record({}, 5);
    record();
    await mark("fingerprints", "refusal:artifact:write", marked("fixed"));

    expect(view().groups[0]).toMatchObject({
      state: { state: "fixed", eventsSince: 1, reopened: true },
      open: true,
    });
  });

  test("a reported fingerprint stays handled and counts the events since", async () => {
    record({}, 5);
    record();
    record();
    await mark("fingerprints", "refusal:artifact:write", marked("reported", "https://acme.test/7"));

    expect(view().groups[0]).toMatchObject({
      state: { state: "reported", link: "https://acme.test/7", eventsSince: 2, reopened: false },
      open: false,
    });
  });

  test("a dismissed fingerprint stays dismissed whatever is recorded later", async () => {
    record();
    await mark("fingerprints", "refusal:artifact:write", marked("dismissed"));

    expect(view().groups[0]).toMatchObject({ state: { reopened: false }, open: false });
  });

  test("a Free Report carries its state", async () => {
    const dismissed = freeReport();
    const unmarked = freeReport();
    await mark("reports", dismissed.id, marked("dismissed"));

    expect(
      view().freeReports.map(({ id, open, state }) => ({ id, open, state: state?.state })),
    ).toEqual(
      expect.arrayContaining([
        { id: dismissed.id, open: false, state: "dismissed" },
        { id: unmarked.id, open: true, state: undefined },
      ]),
    );
  });

  test("the records carry the derived states of their own items and no other", async () => {
    record({}, 5);
    record();
    const own = freeReport();
    const other = freeReport("docs:acme", "/acme/other");
    await mark("fingerprints", "refusal:artifact:write", marked("fixed"));
    await mark("fingerprints", "refusal:secret:read", marked("fixed"));
    await mark("reports", own.id, marked("dismissed"));
    await mark("reports", other.id, marked("dismissed"));

    expect(readFrictionRecords({ companion: COMPANION }, window()).states).toEqual({
      fingerprints: {
        "refusal:artifact:write": { ...marked("fixed"), eventsSince: 1, reopened: true },
      },
      reports: { [own.id]: marked("dismissed") },
    });
  });
});
