import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { resetActiveDistribution, setActiveDistribution } from "../../../distribution";
import {
  appendEvent,
  appendReport,
  frictionLogDir,
  readReports,
  type NewFrictionEvent,
} from "../../../runtime/friction-log";
import { createFrictionPlugin } from "../../../tools/setup/capabilities/friction";
import { PluginRegistry } from "../../../tools/setup/registry";
import { runFrictionListCommand, runFrictionReportCommand } from "./friction";

const COMPANION = "/acme/companion";
const EXPECTED = "editing a tracked Markdown file is allowed";
const now = new Date("2027-03-14T12:00:00Z");
let home: string;
let stdout: string[];
let stderr: string[];
const originals = { log: console.log, error: console.error, write: process.stdout.write };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mate-friction-list-"));
  stdout = [];
  stderr = [];
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  process.stdout.write = mock((chunk: string, callback?: () => void) => {
    stdout.push(chunk);
    callback?.();
    return true;
  }) as never;
  setActiveDistribution({
    config: { runtime: "bun", version: "1.0.0" },
    registry: new PluginRegistry([{ plugin: createFrictionPlugin(), policy: "optional" }]),
  });
});

afterEach(() => {
  console.log = originals.log;
  console.error = originals.error;
  process.stdout.write = originals.write;
  process.exitCode = 0;
  resetActiveDistribution();
  fs.rmSync(home, { recursive: true, force: true });
});

function record(fingerprint: string, sessionId: string, overrides: Partial<NewFrictionEvent> = {}) {
  return appendEvent(
    {
      kind: "refusal",
      fingerprint,
      mateVersion: "1.0.0",
      runtime: "claude",
      sessionId,
      companion: COMPANION,
      repositoryPath: null,
      detail: {},
      ...overrides,
    },
    { homeDir: home, now: new Date(now.getTime() - 60_000) },
  );
}

function list(argv: string[], capabilities = [{ name: "friction" }]) {
  return runFrictionListCommand(argv, {
    resolveContext: async () => ({ companionPath: COMPANION, config: { capabilities } as never }),
    homeDir: home,
    now,
  });
}

describe("mate cap friction list", () => {
  test("ranks repeats within one session first and reports a group's counts", async () => {
    for (const session of ["a", "b", "c", "d", "e", "f"]) record("refusal:secret:read", session);
    for (let index = 0; index < 4; index++) record("refusal:artifact:write", "g");
    record("refusal:artifact:write", "h", { companion: "/acme/other" });

    await list(["--json"]);

    expect(stdout).toHaveLength(1);
    const document = JSON.parse(stdout[0]);
    expect(document).toMatchObject({
      kind: "friction-list",
      version: 1,
      days: 30,
      companion: COMPANION,
      events: 10,
      sessions: 7,
    });
    expect(document.groups).toMatchObject([
      { fingerprint: "refusal:artifact:write", events: 4, sessions: 1, maxPerSession: 4 },
      { fingerprint: "refusal:secret:read", events: 6, sessions: 6, maxPerSession: 1 },
    ]);
    expect(document.groups[0].versions).toEqual({ "1.0.0": 4 });
  });

  test("--all lists every companion's friction and names each group's companions", async () => {
    record("refusal:artifact:write", "a");
    record("refusal:artifact:write", "b", { companion: "/acme/other" });

    await list(["--all", "--json"]);

    const document = JSON.parse(stdout[0]);
    expect(document).toMatchObject({ companion: null, events: 2 });
    expect(document.groups[0].companions).toEqual({ [COMPANION]: 1, "/acme/other": 1 });
  });

  test("lists the groups in the same order as text", async () => {
    record("refusal:secret:read", "a");
    record("refusal:artifact:write", "b");
    record("refusal:artifact:write", "b");

    await list([]);

    const text = stdout.join("\n");
    expect(text.indexOf("refusal:artifact:write")).toBeLessThan(
      text.indexOf("refusal:secret:read"),
    );
  });

  test("an empty window says so and exits zero", async () => {
    appendEvent(
      {
        kind: "refusal",
        fingerprint: "refusal:secret:read",
        mateVersion: "1.0.0",
        runtime: "claude",
        sessionId: "a",
        companion: COMPANION,
        repositoryPath: null,
        detail: {},
      },
      { homeDir: home, now: new Date("2027-03-05T12:00:00Z") },
    );

    await list(["--days", "7"]);

    expect(stdout).toEqual(["No friction recorded in the last 7 days."]);
    expect(process.exitCode).toBe(0);
  });

  test("shows a group's reports and lists free reports apart", async () => {
    const event = record("refusal:artifact:write", "a")!;
    const reported = { homeDir: home, now: new Date(now.getTime() - 30_000) };
    const base = {
      cost: null,
      evidence: null,
      workaround: null,
      mateVersion: "1.0.0",
      companion: COMPANION,
      sessionId: "a",
      runtime: "claude" as const,
    };
    appendReport(
      { ...base, eventId: event.id, kind: "bug", subject: "hook:artifact", expected: EXPECTED },
      reported,
    );
    appendReport(
      {
        ...base,
        eventId: null,
        kind: "unclear",
        subject: "skill:mate-apply-change",
        expected: "the step names its command",
        evidence: "the step says only 'run it'",
      },
      reported,
    );

    await list(["--json"]);
    const document = JSON.parse(stdout[0]);
    expect(document).toMatchObject({ kind: "friction-list", version: 1 });
    expect(document.groups).toHaveLength(1);
    expect(document.groups[0].reports).toMatchObject([{ eventId: event.id, expected: EXPECTED }]);
    expect(document.freeReports).toMatchObject([{ subject: "skill:mate-apply-change" }]);

    stdout = [];
    await list([]);
    const text = stdout.join("\n");
    expect(text).toContain(`1 reports; latest expected: ${EXPECTED}`);
    expect(text).toContain("Free reports: 1");
  });

  test("refuses without the capability and reads no log", async () => {
    await list([], []);

    expect(stderr.join("\n")).toContain('"friction" capability is not enabled');
    expect(process.exitCode).toBe(1);
    expect(stdout).toEqual([]);
  });
});

const GITHUB_TOKEN = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");

function report(argv: string[], env: Record<string, string | undefined> = {}) {
  return runFrictionReportCommand(argv, {
    resolveContext: async () => ({
      companionPath: COMPANION,
      config: { capabilities: [{ name: "friction" }] } as never,
    }),
    homeDir: home,
    now,
    env,
  });
}

const reports = () => readReports({ sinceDays: 30, homeDir: home, now });

describe("mate cap friction report", () => {
  test("records a report on an event, taking its subject from the event", async () => {
    const event = record("refusal:artifact:write", "a")!;

    await report(
      [
        event.id,
        "--kind",
        "bug",
        "--expected",
        EXPECTED,
        "--cost=detour",
        "--subject",
        "skill:acme",
      ],
      { OPENCODE_SESSION_ID: "s9" },
    );

    const [recorded] = reports();
    expect(recorded).toMatchObject({
      eventId: event.id,
      kind: "bug",
      cost: "detour",
      subject: "hook:artifact",
      expected: EXPECTED,
      evidence: null,
      workaround: null,
      mateVersion: "1.0.0",
      companion: COMPANION,
      sessionId: "s9",
      runtime: "opencode",
    });
    expect(stdout).toEqual([`Recorded friction report ${recorded.id}.`]);
    expect(process.exitCode).toBe(0);
  });

  test("records a free report with a null event id, outside a session", async () => {
    await report([
      "--subject",
      "skill:mate-apply-change",
      "--kind",
      "unclear",
      "--expected",
      "the step names its command",
      "--evidence",
      "the step says only 'run it'",
    ]);

    expect(reports()).toMatchObject([
      { eventId: null, subject: "skill:mate-apply-change", sessionId: null, runtime: null },
    ]);
  });

  test.each([
    [["--expected", EXPECTED], "--kind is required: one of bug, unclear, missing"],
    [["--kind", "annoying", "--expected", EXPECTED], "one of bug, unclear, missing"],
    [["--kind", "bug"], "--expected is required"],
    [["--kind", "bug", "--expected", EXPECTED, "--evidence", "x"], "needs --subject"],
    [["--kind", "bug", "--expected", EXPECTED, "--subject", "vibes", "--evidence", "x"], "skill"],
    [["--kind", "bug", "--expected", EXPECTED, "--subject", "skill:acme"], "needs --evidence"],
    [["F-0", "--kind", "bug", "--expected", EXPECTED], "No Friction Event F-0"],
  ])("refuses %j and records nothing", async (argv, message) => {
    await report(argv);

    expect(stderr.join("\n")).toContain(message);
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(frictionLogDir(home))).toBe(false);
  });

  test("refuses a secret without printing it, and cuts long text", async () => {
    const event = record("refusal:artifact:write", "a")!;

    await report([
      event.id,
      "--kind",
      "bug",
      "--expected",
      EXPECTED,
      "--evidence",
      `token ${GITHUB_TOKEN}`,
    ]);
    expect(stderr.join("\n")).toContain("holds a secret");
    expect([...stdout, ...stderr].join("\n")).not.toContain(GITHUB_TOKEN);
    expect(reports()).toEqual([]);

    process.exitCode = 0;
    await report([event.id, "--kind", "bug", "--expected", "e".repeat(4_000)]);
    expect(reports()[0].expected).toBe("e".repeat(1_000));
  });

  test("--json prints one document on success and on refusal", async () => {
    const event = record("refusal:artifact:write", "a")!;

    await report([event.id, "--kind", "bug", "--expected", EXPECTED, "--json"]);
    await report(["F-0", "--kind", "bug", "--expected", EXPECTED, "--json"]);

    expect(stdout.map((chunk) => JSON.parse(chunk))).toEqual([
      { kind: "friction-report", version: 1, id: reports()[0].id, eventId: event.id },
      {
        kind: "error",
        version: 1,
        error: { code: "event-not-found", message: expect.stringContaining("F-0") },
      },
    ]);
    expect(process.exitCode).toBe(1);
  });
});
