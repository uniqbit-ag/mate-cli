import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  appendEvent,
  appendReport,
  frictionLogDir,
  frictionReportFile,
  type NewFrictionReport,
} from "../../runtime/friction-log";
import { frictionStateFile, readFrictionStates } from "../../runtime/friction-state";
import { markFriction } from "./mark";

const FINGERPRINT = "refusal:artifact:shell";
const TOKEN = ["ghp", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].join("_");
const now = new Date("2027-03-14T12:00:00.000Z");
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mate-friction-mark-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function recordEvent() {
  return appendEvent(
    {
      kind: "refusal",
      fingerprint: FINGERPRINT,
      mateVersion: "1.0.0",
      runtime: "claude",
      sessionId: "s",
      companion: "/acme",
      repositoryPath: null,
      detail: {},
    },
    { homeDir: home, now },
  )!;
}

function recordReport(fields: Partial<NewFrictionReport> = {}) {
  return appendReport(
    {
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
      ...fields,
    },
    { homeDir: home, now },
  );
}

const mark = (
  target: string,
  state: Parameters<typeof markFriction>[1],
  input: { note?: string; link?: string } = {},
  scan?: Parameters<typeof markFriction>[3]["scan"],
) => markFriction(target, state, { ...input, by: "person" }, { homeDir: home, now, scan });

const stateFileText = () =>
  fs.existsSync(frictionStateFile(home)) ? fs.readFileSync(frictionStateFile(home), "utf8") : null;

describe("markFriction", () => {
  test("sets a fingerprint's state with its link, and open clears it", async () => {
    recordEvent();

    const reported = await mark(FINGERPRINT, "reported", { link: "https://acme.test/issues/7" });
    expect(reported).toEqual({
      ok: true,
      target: FINGERPRINT,
      state: {
        state: "reported",
        at: now.toISOString(),
        by: "person",
        note: null,
        link: "https://acme.test/issues/7",
      },
    });
    expect(readFrictionStates(home).fingerprints[FINGERPRINT]?.state).toBe("reported");

    expect(await mark(FINGERPRINT, "open")).toEqual({ ok: true, target: FINGERPRINT, state: null });
    expect(readFrictionStates(home).fingerprints).toEqual({});
  });

  test("a fingerprint known only to the state file resolves without the log", async () => {
    fs.mkdirSync(frictionLogDir(home), { recursive: true });
    fs.writeFileSync(
      frictionStateFile(home),
      JSON.stringify({
        v: 1,
        fingerprints: {
          [FINGERPRINT]: {
            state: "fixed",
            at: now.toISOString(),
            by: "person",
            note: null,
            link: null,
          },
        },
        reports: {},
      }),
    );

    expect(await mark(FINGERPRINT, "dismissed")).toMatchObject({ ok: true });
  });

  test("a mark without text never calls the scanner", async () => {
    recordEvent();
    const scan = mock(async () => []);

    await mark(FINGERPRINT, "fixed", {}, scan);

    expect(scan).not.toHaveBeenCalled();
  });

  test.each([
    [
      "a link without reported",
      () => mark(FINGERPRINT, "fixed", { link: "https://acme.test/1" }),
      "link-needs-reported",
      "--state reported",
    ],
    [
      "a non-http link",
      () => mark(FINGERPRINT, "reported", { link: "file:///etc/hosts" }),
      "invalid-link",
      "http",
    ],
    [
      "an unknown target",
      () => mark("command:acme:1", "fixed"),
      "unknown-target",
      "command:acme:1",
    ],
    [
      "a report on an event",
      async () => mark(recordReport({ eventId: recordEvent().id }).id, "fixed"),
      "report-on-event",
      FINGERPRINT,
    ],
  ] as const)("refuses %s and leaves the state file unchanged", async (_case, run, code, named) => {
    recordEvent();
    const before = stateFileText();

    const result = await run();

    expect(result).toMatchObject({ ok: false, code, reason: expect.stringContaining(named) });
    expect(stateFileText()).toBe(before);
  });

  test("refuses a note with a secret without repeating it", async () => {
    recordEvent();

    const result = await mark(FINGERPRINT, "dismissed", { note: `token ${TOKEN}` });

    expect(result).toMatchObject({ ok: false, code: "secret" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(stateFileText()).toBeNull();
  });

  test("refuses to write over a malformed state file and names it", async () => {
    recordEvent();
    fs.writeFileSync(frictionStateFile(home), "{");

    const result = await mark(FINGERPRINT, "fixed");

    expect(result).toMatchObject({
      ok: false,
      code: "state-file-damaged",
      reason: expect.stringContaining(frictionStateFile(home)),
    });
    expect(stateFileText()).toBe("{");
  });

  test("marks a Free Report and drops the state of a report retention removed", async () => {
    const report = recordReport();
    const gone = recordReport();
    await mark(gone.id, "dismissed");
    const file = fs.readdirSync(frictionLogDir(home)).find((name) => name.startsWith("reports-"))!;
    const kept = fs
      .readFileSync(path.join(frictionLogDir(home), file), "utf8")
      .split("\n")
      .filter((line) => !line.includes(gone.id))
      .join("\n");
    fs.writeFileSync(path.join(frictionLogDir(home), file), kept);

    expect(await mark(report.id, "dismissed")).toMatchObject({ ok: true });
    expect(Object.keys(readFrictionStates(home).reports)).toEqual([report.id]);
  });

  test("keeps a report's state when its line cannot be parsed", async () => {
    const report = recordReport();
    const newer = recordReport();
    await mark(newer.id, "dismissed");
    const file = frictionReportFile("2027-03", home);
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, text.replace(`{"v":1,"id":"${newer.id}"`, `{"v":2,"id":"${newer.id}"`));

    expect(await mark(report.id, "dismissed")).toMatchObject({ ok: true });
    expect(readFrictionStates(home).reports[newer.id]?.state).toBe("dismissed");
  });
});
