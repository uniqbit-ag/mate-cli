import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  appendEvent,
  appendReport,
  findEvent,
  firstInSession,
  frictionLogDir,
  frictionLogFile,
  frictionReportFile,
  readEvents,
  readFriction,
  readReports,
  type NewFrictionEvent,
  type NewFrictionReport,
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

  test("the first event of a month deletes only the months wholly older than 90 days", () => {
    const home = tempHome();
    for (const day of ["2026-12-15", "2027-01-15", "2027-02-10", "2027-03-15", "2027-04-15"]) {
      appendEvent(event({ sessionId: day }), { homeDir: home, now: new Date(`${day}T00:00:00Z`) });
    }
    const now = new Date("2027-05-01T00:00:00Z");
    appendEvent(event(), { homeDir: home, now });

    expect(fs.readdirSync(frictionLogDir(home)).sort()).toEqual([
      "events-2027-01.jsonl",
      "events-2027-02.jsonl",
      "events-2027-03.jsonl",
      "events-2027-04.jsonl",
      "events-2027-05.jsonl",
    ]);
    expect(readEvents({ sinceDays: 90, homeDir: home, now })[0].sessionId).toBe("2027-02-10");
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
    const { detail: _detail, ...withoutDetail } = event({ sessionId: "no-detail" });
    const noDetail = JSON.stringify({ ...withoutDetail, v: 1, id: "x", at: now.toISOString() });
    fs.appendFileSync(frictionLogFile("2027-03", home), `{"v":2}\nnot json\n${noDetail}\n`);
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

  test("returns nothing when no log exists", () => {
    expect(readEvents({ sinceDays: 30, homeDir: tempHome(), now })).toEqual([]);
  });
});

function report(overrides: Partial<NewFrictionReport> = {}): NewFrictionReport {
  return {
    eventId: null,
    kind: "unclear",
    cost: null,
    subject: "skill:acme",
    expected: "the step names its command",
    evidence: "the step says only 'run it'",
    workaround: null,
    mateVersion: "1.0.0",
    companion: "/acme/companion",
    sessionId: "s1",
    runtime: "claude",
    ...overrides,
  };
}

describe("appendReport", () => {
  test("appends one line per report to the month's reports file", () => {
    const home = tempHome();
    const now = new Date("2027-03-14T10:00:00Z");
    const first = appendReport(report(), { homeDir: home, now });
    appendReport(report(), { homeDir: home, now });

    const recorded = lines(frictionReportFile("2027-03", home)).map((line) => JSON.parse(line));
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toEqual({ v: 1, id: first.id, at: now.toISOString(), ...report() });
    expect(fs.existsSync(frictionLogFile("2027-03", home))).toBe(false);
  });

  test("a new month deletes the report files wholly older than 90 days", () => {
    const home = tempHome();
    for (const month of ["2026-12", "2027-01", "2027-02", "2027-03", "2027-04"]) {
      appendReport(report(), { homeDir: home, now: new Date(`${month}-15T00:00:00Z`) });
    }

    expect(fs.readdirSync(frictionLogDir(home)).sort()).toEqual([
      "reports-2027-01.jsonl",
      "reports-2027-02.jsonl",
      "reports-2027-03.jsonl",
      "reports-2027-04.jsonl",
    ]);
  });

  test("returns the written report when an old file cannot be pruned", () => {
    const home = tempHome();
    // rmSync without `recursive` refuses a folder, so the prune fails after the append.
    fs.mkdirSync(frictionReportFile("2026-12", home), { recursive: true });

    const written = appendReport(report(), {
      homeDir: home,
      now: new Date("2027-05-01T00:00:00Z"),
    });

    expect(lines(frictionReportFile("2027-05", home)).map((line) => JSON.parse(line).id)).toEqual([
      written.id,
    ]);
  });
});

describe("readReports", () => {
  const now = new Date("2027-03-14T12:00:00Z");

  test("skips a malformed line", () => {
    const home = tempHome();
    appendReport(report({ companion: "/acme/one" }), { homeDir: home, now });
    fs.appendFileSync(frictionReportFile("2027-03", home), '{"v":1,"id":"x"}\nnot json\n');
    appendReport(report({ companion: "/acme/two" }), { homeDir: home, now });

    expect(readReports({ sinceDays: 30, homeDir: home, now })).toHaveLength(2);
  });
});

describe("readFriction", () => {
  const now = new Date("2027-03-14T12:00:00Z");
  const window = { sinceDays: 30, now };

  test("a companion's events, the reports on them wherever made, and its free reports", () => {
    const home = tempHome();
    const at = { homeDir: home, now };
    const one = appendEvent(event({ companion: "/acme/one" }), at)!;
    const two = appendEvent(event({ companion: "/acme/two" }), at)!;
    appendReport(report({ eventId: one.id, companion: "/acme/one", subject: "on one" }), at);
    appendReport(report({ eventId: two.id, companion: "/acme/one", subject: "on two" }), at);
    appendReport(report({ companion: "/acme/one", subject: "free one" }), at);
    appendReport(report({ companion: "/acme/two", subject: "free two" }), at);

    const scoped = readFriction({ companion: "/acme/two" }, { ...window, homeDir: home });

    expect(scoped.events.map((entry) => entry.id)).toEqual([two.id]);
    expect(scoped.reports.map((entry) => entry.subject)).toEqual(["on two", "free two"]);
    expect(readFriction("all", { ...window, homeDir: home }).reports).toHaveLength(4);
  });

  test("a record without a companion matches no companion, only all", () => {
    const home = tempHome();
    appendReport(report({ companion: "" }), { homeDir: home, now });

    const here = readFriction({ companion: process.cwd() }, { ...window, homeDir: home });

    expect(here.reports).toEqual([]);
    expect(readFriction("all", { ...window, homeDir: home }).reports).toHaveLength(1);
  });
});

describe("findEvent", () => {
  test("finds an event in an earlier month and returns null for an unknown id", () => {
    const home = tempHome();
    const old = appendEvent(event(), { homeDir: home, now: new Date("2027-02-01T00:00:00Z") });
    appendEvent(event(), { homeDir: home, now: new Date("2027-03-01T00:00:00Z") });

    expect(findEvent(old!.id, { homeDir: home })).toEqual(old);
    expect(findEvent("no-such-event", { homeDir: home })).toBeNull();
    expect(findEvent("no-such-event", { homeDir: tempHome() })).toBeNull();
  });
});

describe("firstInSession", () => {
  test("only the session's first event of a fingerprint is first", () => {
    const home = tempHome();
    const now = new Date("2027-03-14T10:00:00Z");
    const first = appendEvent(event(), { homeDir: home, now })!;
    const second = appendEvent(event(), { homeDir: home, now })!;
    const otherSession = appendEvent(event({ sessionId: "s2" }), { homeDir: home, now })!;
    const otherKind = appendEvent(event({ fingerprint: "refusal:secret:read" }), {
      homeDir: home,
      now,
    })!;

    expect(firstInSession(first, { homeDir: home })).toBe(true);
    expect(firstInSession(second, { homeDir: home })).toBe(false);
    expect(firstInSession(otherSession, { homeDir: home })).toBe(true);
    expect(firstInSession(otherKind, { homeDir: home })).toBe(true);
  });
});
