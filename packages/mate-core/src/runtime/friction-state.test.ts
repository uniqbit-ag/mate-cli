import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { appendEvent, frictionLogDir } from "./friction-log";
import {
  FrictionStateFileError,
  frictionStateFile,
  readFrictionStates,
  updateFrictionStates,
} from "./friction-state";
import type { FrictionState } from "./friction-vocabulary";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mate-friction-state-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const fixed: FrictionState = {
  state: "fixed",
  at: "2027-03-14T12:00:00.000Z",
  by: "person",
  note: null,
  link: null,
};

function writeStateFile(text: string) {
  fs.mkdirSync(frictionLogDir(home), { recursive: true });
  fs.writeFileSync(frictionStateFile(home), text);
}

describe("readFrictionStates", () => {
  test("a missing file reads as no states and creates nothing", () => {
    expect(readFrictionStates(home)).toEqual({ v: 1, fingerprints: {}, reports: {} });
    expect(fs.existsSync(frictionLogDir(home))).toBe(false);
  });

  test.each([
    ["invalid JSON", "{"],
    [
      "an unknown state",
      JSON.stringify({ v: 1, fingerprints: { a: { ...fixed, state: "done" } }, reports: {} }),
    ],
    [
      "an unparsable time",
      JSON.stringify({ v: 1, fingerprints: { a: { ...fixed, at: "yesterday" } }, reports: {} }),
    ],
    [
      "a time without UTC zone",
      JSON.stringify({
        v: 1,
        fingerprints: { a: { ...fixed, at: "2027-03-14T12:00:00" } },
        reports: {},
      }),
    ],
  ])("%s reads as no states", (_case, text) => {
    writeStateFile(text);
    expect(readFrictionStates(home)).toEqual({ v: 1, fingerprints: {}, reports: {} });
  });

  test("an unreadable file reads as no states", () => {
    fs.mkdirSync(frictionStateFile(home), { recursive: true });
    expect(readFrictionStates(home).fingerprints).toEqual({});
  });
});

describe("updateFrictionStates", () => {
  test("writes the state file and leaves every log file byte-identical", async () => {
    const event = appendEvent(
      {
        kind: "refusal",
        fingerprint: "refusal:artifact:shell",
        mateVersion: "1.0.0",
        runtime: "claude",
        sessionId: "s",
        companion: "/acme",
        repositoryPath: null,
        detail: {},
      },
      { homeDir: home },
    )!;
    const logs = fs.readdirSync(frictionLogDir(home));
    const before = logs.map((name) => fs.readFileSync(path.join(frictionLogDir(home), name)));

    await updateFrictionStates(
      (states) => {
        states.fingerprints[event.fingerprint] = fixed;
      },
      { homeDir: home },
    );

    expect(logs.map((name) => fs.readFileSync(path.join(frictionLogDir(home), name)))).toEqual(
      before,
    );
    expect(readFrictionStates(home).fingerprints).toEqual({ [event.fingerprint]: fixed });
  });

  test("two concurrent updates of different targets are both kept", async () => {
    await Promise.all(
      ["command:acme:1", "refusal:secret:read"].map((fingerprint) =>
        updateFrictionStates(
          async (states) => {
            states.fingerprints[fingerprint] = fixed;
          },
          { homeDir: home },
        ),
      ),
    );

    expect(Object.keys(readFrictionStates(home).fingerprints).toSorted()).toEqual([
      "command:acme:1",
      "refusal:secret:read",
    ]);
  });

  test("refuses a malformed file, names it and leaves it unchanged", async () => {
    writeStateFile("{");

    const update = updateFrictionStates(
      (states) => {
        states.fingerprints.a = fixed;
      },
      { homeDir: home },
    );

    await expect(update).rejects.toThrow(FrictionStateFileError);
    await expect(update).rejects.toThrow(frictionStateFile(home));
    expect(fs.readFileSync(frictionStateFile(home), "utf8")).toBe("{");
  });
});
