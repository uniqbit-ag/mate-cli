import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { resetActiveDistribution, setActiveDistribution } from "../../distribution";
import {
  appendEvent,
  appendReport,
  frictionLogDir,
  readReports,
  type NewFrictionEvent,
} from "../../runtime/friction-log";
import { readFrictionStates } from "../../runtime/friction-state";
import { readFrictionSwitch, writeFrictionSwitch } from "../../runtime/friction-switch";
import { markFriction } from "../../lib/friction/mark";
import { createTriageSession, recordTriageLauncher } from "../../lib/triage/session";
import { PluginRegistry } from "../../tools/setup/registry";
import {
  runFrictionCommand,
  runFrictionListCommand,
  runFrictionMarkCommand,
  runFrictionReportCommand,
  runFrictionStatusCommand,
  runFrictionSwitchCommand,
} from "./friction";

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
    registry: new PluginRegistry([]),
  });
  writeFrictionSwitch(true, home);
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

function list(argv: string[]) {
  return runFrictionListCommand(argv, {
    resolveContext: async () => ({ companionPath: COMPANION }),
    homeDir: home,
    now,
  });
}

describe("mate friction list", () => {
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

  test("shows the paths refusals named and the flags failed commands carried", async () => {
    record("refusal:artifact:shell", "a", { detail: { paths: ["notes.md"] } });
    record("refusal:artifact:shell", "b", { detail: { paths: ["/tmp/plan.md"] } });
    for (let index = 0; index < 2; index++) {
      record("command:cap acme:1", "c", { kind: "command-failure", detail: { flags: ["--help"] } });
    }

    await list(["--json"]);
    const groups = JSON.parse(stdout[0]).groups;
    stdout = [];
    await list([]);

    expect(groups).toMatchObject([
      { fingerprint: "command:cap acme:1", flags: { "--help": 2 }, paths: {} },
      { fingerprint: "refusal:artifact:shell", paths: { "notes.md": 1, "/tmp/plan.md": 1 } },
    ]);
    const text = stdout.join("\n");
    expect(text).toContain("paths: notes.md ×1, /tmp/plan.md ×1");
    expect(text).toContain("flags: --help ×2");
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
    expect(text).toContain(
      '  "refusal:artifact:write" · The artifact check refused a file write\n',
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
    expect(text).toContain(`1 report; latest expected: ${EXPECTED}`);
    expect(text).toContain("Free reports: 1");
  });

  test.each(["one event", "only a free report"])(
    "text output with %s ends by naming triage",
    async (kind) => {
      if (kind === "one event") record("refusal:artifact:write", "a");
      else
        appendReport(
          {
            eventId: null,
            kind: "missing",
            subject: "docs:acme",
            expected: EXPECTED,
            evidence: "no page names it",
            cost: null,
            workaround: null,
            mateVersion: "1.0.0",
            companion: COMPANION,
            sessionId: "a",
            runtime: "claude",
          },
          { homeDir: home, now: new Date(now.getTime() - 30_000) },
        );

      await list([]);

      expect(stdout.at(-1)).toBe(
        "Next: run mate triage in your own terminal, inside the affected repository.",
      );
    },
  );

  test("recording off still lists earlier records after one line naming friction on", async () => {
    record("refusal:artifact:write", "a");
    record("refusal:secret:read", "b");
    writeFrictionSwitch(false, home);

    await list([]);

    expect(stdout[0]).toContain("recording is off");
    expect(stdout[0]).toContain("mate friction on");
    expect(stdout.join("\n")).toContain("refusal:artifact:write");
    expect(stdout.join("\n")).toContain("refusal:secret:read");
  });

  test("recording off with an empty window says both", async () => {
    writeFrictionSwitch(false, home);

    await list([]);

    expect(stdout).toHaveLength(2);
    expect(stdout[0]).toContain("recording is off");
    expect(stdout[1]).toBe("No friction recorded in the last 30 days.");
  });

  test.each([[[]], [["--json"]]])(
    "outside a companion %j refuses, names --all and lists nothing",
    async (argv) => {
      record("refusal:artifact:write", "a");

      await runFrictionListCommand(argv, { resolveContext: async () => ({}), homeDir: home, now });

      expect(stderr.join("\n")).toContain("--all");
      expect(stderr.join("\n")).toContain("inside the affected repository");
      expect(process.exitCode).toBe(1);
      expect(stdout.map((chunk) => JSON.parse(chunk))).toEqual(
        argv.length > 0
          ? [{ kind: "error", version: 1, error: { code: "no-companion", message: stderr[0] } }]
          : [],
      );
    },
  );

  test("refuses a period longer than the log keeps", async () => {
    await list(["--days", "91"]);

    expect(stderr).toEqual(["--days is at most 90: the Friction Log keeps 90 days."]);
    expect(process.exitCode).toBe(1);
    expect(stdout).toEqual([]);
  });

  test("with --json a bad argument prints an error document", async () => {
    await list(["--json", "--acme"]);

    expect(process.exitCode).toBe(1);
    expect(stdout.map((chunk) => JSON.parse(chunk))).toEqual([
      { kind: "error", version: 1, error: { code: "usage", message: "Unknown argument: --acme" } },
    ]);
  });

  test("the JSON document differs only in recording whether recording is on or off", async () => {
    record("refusal:artifact:write", "a");
    await list(["--json"]);
    writeFrictionSwitch(false, home);
    await list(["--json"]);

    expect(stdout).toHaveLength(2);
    const [on, off] = stdout.map((line) => JSON.parse(line));
    expect(on.recording).toBe(true);
    expect(off).toEqual({ ...on, recording: false });
  });
});

const GITHUB_TOKEN = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");

function report(argv: string[], env: Record<string, string | undefined> = {}) {
  return runFrictionReportCommand(argv, {
    resolveContext: async () => ({ companionPath: COMPANION }),
    homeDir: home,
    now,
    env,
  });
}

const reports = () => readReports({ sinceDays: 30, homeDir: home, now });

describe("mate friction report", () => {
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
    expect(fs.readdirSync(frictionLogDir(home))).toEqual(["settings.json"]);
  });

  test("refuses a free report outside a companion and records nothing", async () => {
    await runFrictionReportCommand(
      [
        "--subject",
        "docs:acme",
        "--kind",
        "missing",
        "--expected",
        EXPECTED,
        "--evidence",
        "x",
        "--json",
      ],
      { resolveContext: async () => ({}), homeDir: home, now, env: {} },
    );

    expect(JSON.parse(stdout[0])).toMatchObject({ kind: "error", error: { code: "no-companion" } });
    expect(process.exitCode).toBe(1);
    expect(reports()).toEqual([]);
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

  test.each([[[]], [["--json"]]])(
    "recording off refuses %j and writes no line and no file",
    async (extra) => {
      fs.rmSync(frictionLogDir(home), { recursive: true });

      await report([
        "--subject",
        "docs:acme",
        "--kind",
        "missing",
        "--expected",
        EXPECTED,
        "--evidence",
        "x",
        ...extra,
      ]);

      expect(stderr.join("\n")).toContain("recording is off");
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(frictionLogDir(home))).toBe(false);
      if (extra.length > 0) {
        expect(JSON.parse(stdout[0])).toMatchObject({
          kind: "error",
          error: { code: "recording-off" },
        });
      }
    },
  );
});

describe("mate friction on, off and status", () => {
  const agent = { CLAUDE_CODE_SESSION_ID: "s1" };

  test("on and off set the switch, also when it already has that state", () => {
    fs.rmSync(frictionLogDir(home), { recursive: true });

    runFrictionSwitchCommand(true, [], { homeDir: home, env: {} });
    runFrictionSwitchCommand(true, [], { homeDir: home, env: {} });
    expect(readFrictionSwitch(home)).toBe(true);
    expect(stdout).toHaveLength(2);
    expect(stdout[0]).toContain("recording is on");
    expect(stdout[1]).toBe(stdout[0]);

    runFrictionSwitchCommand(false, [], { homeDir: home, env: {} });
    expect(readFrictionSwitch(home)).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  test("off keeps the records and names the log folder", () => {
    for (const session of ["a", "b", "c"]) record("refusal:artifact:write", session);

    runFrictionSwitchCommand(false, [], { homeDir: home, env: {} });

    expect(stdout[0]).toContain("recording is off");
    expect(stdout[0]).toContain(`stay in ${frictionLogDir(home)}`);
    expect(
      fs.readdirSync(frictionLogDir(home)).filter((name) => name.startsWith("events-")),
    ).toHaveLength(1);
  });

  test.each([
    [false, agent],
    [true, { OPENCODE_SESSION_ID: "s2" }],
  ])("an agent session cannot set the switch to %p", (recording, env) => {
    writeFrictionSwitch(!recording, home);

    runFrictionSwitchCommand(recording, [], { homeDir: home, env });

    expect(stderr.join("\n")).toContain("your own terminal");
    expect(process.exitCode).toBe(1);
    expect(readFrictionSwitch(home)).toBe(!recording);
  });

  test("status names the state and the folder, also inside an agent session", async () => {
    const previous = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = "s1";
    try {
      await runFrictionStatusCommand([], { homeDir: home });
      writeFrictionSwitch(false, home);
      await runFrictionStatusCommand(["--json"], { homeDir: home });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = previous;
    }

    expect(stdout[0]).toBe(`Friction recording is on. Friction Log: ${frictionLogDir(home)}`);
    expect(JSON.parse(stdout[1])).toEqual({
      kind: "friction-status",
      version: 1,
      recording: false,
      logDir: frictionLogDir(home),
    });
    expect(process.exitCode).toBe(0);
  });

  test("an unknown subcommand names the friction subcommands", async () => {
    await runFrictionCommand("frobnicate", []);

    expect(stderr.join("\n")).toContain("Unknown friction subcommand: frobnicate");
    expect(stderr.join("\n")).toContain("on|off|status|list|report|mark");
    expect(process.exitCode).toBe(1);
  });
});

/** Marks as a person would, `minutes` before the list's now. */
async function setState(
  target: string,
  state: "fixed" | "reported" | "dismissed",
  minutes: number,
  link?: string,
) {
  const result = await markFriction(
    target,
    state,
    { by: "person", link },
    { homeDir: home, now: new Date(now.getTime() - minutes * 60_000) },
  );
  expect(result.ok).toBe(true);
}

describe("mate friction list --state", () => {
  test("hides handled items by default and says how to show them", async () => {
    record("refusal:artifact:write", "a");
    record("refusal:secret:read", "b");
    await setState("refusal:secret:read", "fixed", 0);

    await list([]);

    const text = stdout.join("\n");
    expect(text).toContain("refusal:artifact:write");
    expect(text).not.toContain("refusal:secret:read");
    expect(text).toContain("1 handled item hidden; mate friction list --state all shows them.");
    expect(text).toContain("2 events in 2 sessions");
  });

  test("a reopened fix is open, not handled", async () => {
    record("refusal:artifact:write", "a");
    await setState("refusal:artifact:write", "fixed", 5);

    await list(["--json"]);
    await list(["--state", "handled", "--json"]);

    const [open, handled] = stdout.map((chunk) => JSON.parse(chunk));
    expect(open.groups).toMatchObject([
      { fingerprint: "refusal:artifact:write", state: { state: "fixed", reopened: true } },
    ]);
    expect(handled).toMatchObject({ state: "handled", hidden: 1, groups: [] });
  });

  test("everything handled says no open item is in the window and exits zero", async () => {
    record("refusal:artifact:write", "a");
    await setState("refusal:artifact:write", "dismissed", 0);

    await list([]);

    expect(stdout).toEqual([
      "Friction in the last 30 days: 1 event in 1 session",
      "No open item: 1 item hidden; mate friction list --state all shows them.",
    ]);
    expect(process.exitCode).toBe(0);
  });

  test("shows a reported group's link and the events since, in text and JSON", async () => {
    record("refusal:artifact:write", "a");
    record("refusal:artifact:write", "b");
    await setState("refusal:artifact:write", "reported", 5, "https://acme.test/issues/7");
    const report = appendReport(
      {
        eventId: null,
        kind: "missing",
        subject: "docs:acme",
        expected: EXPECTED,
        evidence: "x",
        cost: null,
        workaround: null,
        mateVersion: "1.0.0",
        companion: COMPANION,
        sessionId: null,
        runtime: null,
      },
      { homeDir: home, now: new Date(now.getTime() - 30_000) },
    );

    await list(["--state", "all"]);
    const text = stdout.join("\n");
    expect(text).toContain("reported by person");
    expect(text).toContain("https://acme.test/issues/7; 2 events since reported");

    stdout = [];
    await list(["--state", "all", "--json"]);
    const document = JSON.parse(stdout[0]);
    expect(document).toMatchObject({ kind: "friction-list", version: 1, state: "all", hidden: 0 });
    expect(document.groups[0].state).toMatchObject({
      state: "reported",
      by: "person",
      link: "https://acme.test/issues/7",
      note: null,
      eventsSince: 2,
      reopened: false,
    });
    expect(document.freeReports).toMatchObject([{ id: report.id, state: null }]);
  });

  test("a bad --state is a usage error", async () => {
    await list(["--state", "closed", "--json"]);

    expect(JSON.parse(stdout[0])).toMatchObject({ kind: "error", error: { code: "usage" } });
    expect(process.exitCode).toBe(1);
  });
});

describe("mate friction mark", () => {
  const agent = { CLAUDE_CODE_SESSION_ID: "s1" };
  const mark = (
    argv: string[],
    env: Record<string, string> = {},
    cwd = home,
    isAncestor = (pid: number) => pid === process.pid,
  ) => runFrictionMarkCommand(argv, { homeDir: home, now, env, cwd, isAncestor });

  test("a person marks in their own terminal, in text and JSON", async () => {
    record("refusal:artifact:write", "a");

    await mark(["refusal:artifact:write", "--state", "fixed"]);
    await mark(["refusal:artifact:write", "--state=dismissed", "--note", "not Mate's", "--json"]);

    expect(stdout[0]).toBe("Marked refusal:artifact:write as fixed.");
    expect(JSON.parse(stdout[1])).toEqual({
      kind: "friction-state",
      version: 1,
      target: "refusal:artifact:write",
      state: {
        state: "dismissed",
        at: now.toISOString(),
        by: "person",
        note: "not Mate's",
        link: null,
      },
    });
  });

  test("an agent outside a triage session cannot mark", async () => {
    record("refusal:artifact:write", "a");

    await mark(["refusal:artifact:write", "--state", "dismissed", "--json"], agent);

    expect(JSON.parse(stdout[0])).toMatchObject({
      kind: "error",
      error: { code: "agent-session" },
    });
    expect(stderr.join("\n")).toContain("your own terminal");
    expect(process.exitCode).toBe(1);
    expect(readFrictionStates(home).fingerprints).toEqual({});
  });

  test("the triage agent marks from its session folder", async () => {
    record("refusal:artifact:write", "a");
    const session = createTriageSession({ homeDir: home });
    recordTriageLauncher(session);

    await mark(["refusal:artifact:write", "--state", "fixed"], agent, session);

    expect(readFrictionStates(home).fingerprints["refusal:artifact:write"]?.by).toBe("triage");
  });

  test("an agent cannot mark from a folder it made or from an old triage session", async () => {
    record("refusal:artifact:write", "a");
    const made = createTriageSession({ homeDir: home });
    const old = createTriageSession({ homeDir: home });
    recordTriageLauncher(old);
    const dismiss = ["refusal:artifact:write", "--state", "dismissed", "--json"];

    await mark(dismiss, agent, made);
    await mark(dismiss, agent, old, () => false);

    expect(stdout.map((line) => JSON.parse(line).error?.code)).toEqual([
      "agent-session",
      "agent-session",
    ]);
    expect(readFrictionStates(home).fingerprints).toEqual({});
  });

  test.each([
    [["--state", "fixed"], "usage"],
    [["refusal:artifact:write", "--state", "closed"], "invalid-state"],
    [["command:acme:1", "--state", "fixed"], "unknown-target"],
  ])("refuses %j with code %s and exit code 1", async (argv, code) => {
    record("refusal:artifact:write", "a");

    await mark([...argv, "--json"]);

    expect(JSON.parse(stdout[0])).toMatchObject({ kind: "error", error: { code } });
    expect(process.exitCode).toBe(1);
  });
});
