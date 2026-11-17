import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import { appendEvent, frictionLogDir, type NewFrictionEvent } from "../../runtime/friction-log";
import { writeFrictionSwitch } from "../../runtime/friction-switch";
import { readFrictionView } from "./view";

const COMPANION = "/acme/companion";
const now = new Date("2027-03-14T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mate-friction-view-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function record(overrides: Partial<NewFrictionEvent> = {}, daysAgo = 1) {
  appendEvent(
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
  );
}

const view = (days: number) => readFrictionView(COMPANION, { days, homeDir: home, now });

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

test("carries the switch state", () => {
  expect(view(30).recording).toBe(false);
  writeFrictionSwitch(true, home);
  expect(view(30).recording).toBe(true);
});

test("returns no refusal message, command text or error text of an event", () => {
  record({
    detail: { message: "acme refusal message", command: "acme command", error: "acme error" },
  });
  expect(JSON.stringify(view(30))).not.toContain("acme ");
});

test("a read creates no file or folder", () => {
  view(30);
  expect(fs.existsSync(frictionLogDir(home))).toBe(false);
  expect(fs.readdirSync(home)).toEqual([]);
});
