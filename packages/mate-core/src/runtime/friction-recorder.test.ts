import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { frictionLogDir, readEvents } from "./friction-log";
import { commandFingerprint } from "./friction-fingerprint";
import {
  commandDetail,
  recordRefusal,
  refusalDetail,
  type RefusalRecord,
} from "./friction-recorder";
import { writeFrictionSwitch } from "./friction-switch";
import { mateVersion } from "./install";

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function companion(): string {
  const dir = tempDir("mate-friction-companion-");
  fs.mkdirSync(path.join(dir, ".mate", "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mate", "config", "framework.yaml"), "capabilities: []\n");
  return dir;
}

function recordingHome(): string {
  const home = tempDir("mate-friction-home-");
  writeFrictionSwitch(true, home);
  return home;
}

describe("refusalDetail", () => {
  test("cuts message and paths to their limits", () => {
    const detail = refusalDetail({
      check: "artifact",
      toolKind: "write",
      message: "m".repeat(3_000),
      paths: ["a", "b", "c", "d", "e", "f"],
    });
    expect((detail.message as string).length).toBe(1_000);
    expect(detail.paths).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("holds only check and tool kind for a secret refusal", () => {
    expect(
      refusalDetail({
        check: "secret",
        toolKind: "read",
        message: "refused to read .env.production",
        paths: ["/acme/.env.production"],
      }),
    ).toEqual({ check: "secret", toolKind: "read" });
  });
});

describe("recordRefusal", () => {
  function record(companionPath: string, home: string, overrides: Partial<RefusalRecord> = {}) {
    return recordRefusal({
      check: "artifact",
      toolKind: "write",
      message: "refused",
      paths: ["/acme/repo/notes.md"],
      companionPath,
      repositoryPath: "/acme/repo",
      runtime: "claude",
      sessionId: "s1",
      env: { HOME: home },
      ...overrides,
    });
  }

  test("appends one refusal event while recording is on, whatever the companion configures", () => {
    const home = recordingHome();
    const selected = companion();
    record(selected, home);

    const [event] = readEvents({ sinceDays: 1, homeDir: home });
    expect(event).toMatchObject({
      kind: "refusal",
      fingerprint: "refusal:artifact:write",
      mateVersion: mateVersion(),
      runtime: "claude",
      sessionId: "s1",
      companion: selected,
      detail: { check: "artifact", toolKind: "write", paths: ["/acme/repo/notes.md"] },
    });
  });

  test("keeps no value of a secret-named variable in a refusal message", () => {
    const home = recordingHome();
    const secret = "acme-secret-value-123";
    record(companion(), home, {
      check: "attribution",
      toolKind: "shell",
      message: `refused: git push https://x:${secret}@example.com/acme`,
      env: { HOME: home, ACME_TOKEN: secret },
    });

    const [event] = readEvents({ sinceDays: 1, homeDir: home });
    expect(event.detail.message).toBe("refused: git push https://x:***@example.com/acme");
  });

  test("a refused secret read leaves neither file name nor message", () => {
    const home = recordingHome();
    record(companion(), home, {
      check: "secret",
      toolKind: "read",
      message: "Mate refused to read .env.production",
      paths: ["/acme/repo/.env.production"],
    });

    const text = fs.readFileSync(
      path.join(frictionLogDir(home), fs.readdirSync(frictionLogDir(home))[0]),
      "utf8",
    );
    expect(text).not.toContain(".env.production");
    expect(text).not.toContain("refused");
  });

  test("returns one nudge line naming the event, only for a session's first refusal of a kind", () => {
    const home = recordingHome();
    const selected = companion();

    const first = record(selected, home);
    const second = record(selected, home);
    const otherSession = record(selected, home, { sessionId: "s2" });

    const [event] = readEvents({ sinceDays: 1, homeDir: home });
    expect(first).toBe(
      `Wrong or unclear? Run: mate friction report ${event.id} --kind <bug|unclear> --expected "<what you expected>". Then continue with your task.`,
    );
    expect(second).toBeNull();
    expect(otherSession).toContain("mate friction report");
  });

  test("recording off writes nothing and creates no folder", () => {
    const home = tempDir("mate-friction-home-");
    expect(record(companion(), home)).toBeNull();

    expect(fs.existsSync(frictionLogDir(home))).toBe(false);
  });
});

describe("command projection", () => {
  test("names flags without their values", () => {
    const failure = {
      args: ["studio", "serve", "--token", "abc123", "--port=1"],
      exitCode: 1,
      errorText: "port in use",
    };
    const detail = commandDetail(failure);

    expect(detail).toEqual({
      command: "studio",
      subcommand: "serve",
      flags: ["--token", "--port"],
      exitCode: 1,
      errorText: "port in use",
    });
    expect(JSON.stringify(detail)).not.toContain("abc123");
    expect(commandFingerprint(detail)).toBe("command:studio serve:1");
  });

  test("keeps no flag value that starts with a dash", () => {
    const detail = commandDetail({
      args: ["friction", "report", "--evidence", "-acme abc123", "--expected", "-abc123", "-h"],
      exitCode: 1,
      errorText: "",
    });

    expect(detail.flags).toEqual(["--evidence", "--expected", "-h"]);
  });

  test("keeps no dash-leading value echoed in the error text", () => {
    const detail = commandDetail({
      args: ["friction", "report", "--kind", "-abc123"],
      exitCode: 1,
      errorText: '--kind must be one of bug; got "-abc123".',
    });

    expect(detail.errorText).toBe('--kind must be one of bug; got "…".');
  });

  test("keeps no argument value echoed in the error text, and no path as subcommand", () => {
    const failure = {
      args: ["opencode", "acme", "/acme/repo", "--days=abc123"],
      exitCode: 1,
      errorText: "--days needs a whole number of days, got abc123 for /acme/repo",
    };
    const detail = commandDetail(failure);

    expect(detail.subcommand).toBeNull();
    expect(JSON.stringify(detail)).not.toContain("abc123");
    expect(JSON.stringify(detail)).not.toContain("/acme/repo");
    expect(commandFingerprint(detail)).toBe("command:opencode:1");
  });

  test("keeps no word-like value as subcommand of a command without subcommands", () => {
    const id = "a2e4644c-0000-4000-8000-000000000000";
    const detail = commandDetail({
      args: ["triage", id, "--no-launch"],
      exitCode: 1,
      errorText: `mate: ${id} is a report on an event`,
    });

    expect(JSON.stringify(detail)).not.toContain(id);
    expect(commandFingerprint(detail)).toBe("command:triage:1");
  });

  test("names the command a cap namespace ran, and no path a namespace takes first", () => {
    const fingerprint = (args: string[]) =>
      commandFingerprint(commandDetail({ args, exitCode: 1, errorText: "" }));

    expect(fingerprint(["cap", "acme", "validate", "acme-change"])).toBe(
      "command:cap acme validate:1",
    );
    expect(fingerprint(["cap", "graphify", "acme", "--update"])).toBe("command:cap graphify:1");
  });

  test("replaces an echoed value only where it stands as a whole word", () => {
    const errorText = "installation is incomplete. Run mate install before continuing.";
    const detail = commandDetail({
      args: ["friction", "list", "--state", "all"],
      exitCode: 1,
      errorText,
    });

    expect(detail.errorText).toBe(errorText);
  });

  test("leaves an echoed value shorter than three characters in the error text", () => {
    const detail = commandDetail({
      args: ["studio", "serve", "--port", "0"],
      exitCode: 1,
      errorText: "invalid --port value: 0 (exit code 1)",
    });

    expect(detail.flags).toEqual(["--port"]);
    expect(detail.errorText).toBe("invalid --port value: 0 (exit code 1)");
  });

  test("keeps the tail of long error text", () => {
    const detail = commandDetail({
      args: ["doctor"],
      exitCode: 2,
      errorText: `x${"e".repeat(1_500)}`,
    });
    expect(detail.errorText).toBe("e".repeat(1_000));
    expect(commandFingerprint(detail)).toBe("command:doctor:2");
  });
});
