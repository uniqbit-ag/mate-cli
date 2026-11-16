import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { resetActiveDistribution, setActiveDistribution } from "../../../distribution";
import { appendEvent, type NewFrictionEvent } from "../../../runtime/friction-log";
import { createFrictionPlugin } from "../../../tools/setup/capabilities/friction";
import { PluginRegistry } from "../../../tools/setup/registry";
import { runFrictionListCommand } from "./friction";

const COMPANION = "/acme/companion";
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
  appendEvent(
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

  test("refuses without the capability and reads no log", async () => {
    await list([], []);

    expect(stderr.join("\n")).toContain('"friction" capability is not enabled');
    expect(process.exitCode).toBe(1);
    expect(stdout).toEqual([]);
  });
});
