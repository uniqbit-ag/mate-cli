import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  appendEvent,
  frictionLogDir,
  frictionLogFile,
  readEvents,
  type NewFrictionEvent,
} from "./friction-log";

const tempRoots: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-friction-log-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function event(overrides: Partial<NewFrictionEvent> = {}): NewFrictionEvent {
  return {
    kind: "refusal",
    fingerprint: "refusal:artifact:write",
    mateVersion: "1.0.0",
    runtime: "claude",
    sessionId: "s1",
    companion: "/acme/companion",
    repositoryPath: "/acme/repo",
    detail: { check: "artifact", toolKind: "write" },
    ...overrides,
  };
}

function lines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

describe("appendEvent", () => {
  test("appends one line per event to the month's file under Mate's home", () => {
    const home = tempHome();
    const now = new Date("2027-03-14T10:00:00Z");
    appendEvent(event(), { homeDir: home, now });
    appendEvent(event({ sessionId: "s2" }), { homeDir: home, now });

    const file = path.join(home, ".mate", "friction", "events-2027-03.jsonl");
    expect(frictionLogFile("2027-03", home)).toBe(file);
    const recorded = lines(file).map((line) => JSON.parse(line));
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({ v: 1, at: now.toISOString(), sessionId: "s1" });
    expect(recorded[0].id).not.toBe(recorded[1].id);
  });

  test("swallows a failing write", () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, ".mate"), "not a folder");

    expect(() => appendEvent(event(), { homeDir: home })).not.toThrow();
  });

  test("the first event of a month deletes files older than the two months before it", () => {
    const home = tempHome();
    for (const month of ["2027-01", "2027-02", "2027-03"]) {
      appendEvent(event(), { homeDir: home, now: new Date(`${month}-15T00:00:00Z`) });
    }
    appendEvent(event(), { homeDir: home, now: new Date("2027-04-01T00:00:00Z") });

    expect(fs.readdirSync(frictionLogDir(home)).sort()).toEqual([
      "events-2027-02.jsonl",
      "events-2027-03.jsonl",
      "events-2027-04.jsonl",
    ]);
  });

  test("an append to an existing file deletes nothing", () => {
    const home = tempHome();
    appendEvent(event(), { homeDir: home, now: new Date("2027-04-01T00:00:00Z") });
    // An old file that only a new month's first event would prune.
    fs.writeFileSync(frictionLogFile("2026-01", home), "");
    appendEvent(event(), { homeDir: home, now: new Date("2027-04-02T00:00:00Z") });

    expect(fs.existsSync(frictionLogFile("2026-01", home))).toBe(true);
  });
});

describe("readEvents", () => {
  const now = new Date("2027-03-14T12:00:00Z");

  test("skips a line it cannot parse", () => {
    const home = tempHome();
    appendEvent(event(), { homeDir: home, now });
    fs.appendFileSync(frictionLogFile("2027-03", home), '{"v":2}\nnot json\n');
    appendEvent(event({ sessionId: "s2" }), { homeDir: home, now });

    expect(
      readEvents({ sinceDays: 30, homeDir: home, now }).map((entry) => entry.sessionId),
    ).toEqual(["s1", "s2"]);
  });

  test("reads only events inside the window, across monthly files", () => {
    const home = tempHome();
    appendEvent(event({ sessionId: "old" }), {
      homeDir: home,
      now: new Date("2027-03-05T11:59:59Z"),
    });
    appendEvent(event({ sessionId: "edge" }), {
      homeDir: home,
      now: new Date("2027-03-07T12:00:00Z"),
    });
    appendEvent(event({ sessionId: "february" }), {
      homeDir: home,
      now: new Date("2027-02-28T00:00:00Z"),
    });

    expect(
      readEvents({ sinceDays: 7, homeDir: home, now }).map((entry) => entry.sessionId),
    ).toEqual(["edge"]);
    expect(
      readEvents({ sinceDays: 30, homeDir: home, now }).map((entry) => entry.sessionId),
    ).toEqual(["february", "old", "edge"]);
  });

  test("filters by companion", () => {
    const home = tempHome();
    appendEvent(event({ companion: "/acme/one" }), { homeDir: home, now });
    appendEvent(event({ companion: "/acme/two" }), { homeDir: home, now });

    expect(
      readEvents({ sinceDays: 30, companion: "/acme/two", homeDir: home, now }).map(
        (entry) => entry.companion,
      ),
    ).toEqual(["/acme/two"]);
  });

  test("returns nothing when no log exists", () => {
    expect(readEvents({ sinceDays: 30, homeDir: tempHome(), now })).toEqual([]);
  });
});
