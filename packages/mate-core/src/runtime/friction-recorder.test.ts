import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { frictionLogDir, readEvents } from "./friction-log";
import {
  commandDetail,
  commandFingerprint,
  frictionSelected,
  nudgeLine,
  recordRefusal,
  refusalDetail,
  type RefusalRecord,
} from "./friction-recorder";

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function companion(capabilities: string[]): string {
  const dir = tempDir("mate-friction-companion-");
  fs.mkdirSync(path.join(dir, ".mate", "config"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".mate", "config", "framework.yaml"),
    `capabilities:\n${capabilities.map((name) => `  - name: ${name}\n`).join("")}`,
  );
  return dir;
}

describe("frictionSelected", () => {
  test("follows the companion's capability selection", () => {
    expect(frictionSelected(companion(["friction"]))).toBe(true);
    expect(frictionSelected(companion(["rtk"]))).toBe(false);
    expect(frictionSelected("")).toBe(false);
  });
});

describe("refusalDetail", () => {
  test("cuts message, command and paths to their limits", () => {
    const detail = refusalDetail({
      check: "attribution",
      toolKind: "shell",
      message: "m".repeat(3_000),
      command: "c".repeat(3_000),
      paths: ["a", "b", "c", "d", "e", "f"],
    });
    expect((detail.message as string).length).toBe(1_000);
    expect(detail.command).toBe("c".repeat(500));
    expect(detail.paths).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("keeps no heredoc body or assigned value of a shell command", () => {
    const detail = refusalDetail({
      check: "attribution",
      toolKind: "shell",
      message: "refused",
      command: 'TOKEN="x\\"ab\\\nc123" git commit -F - <<\'EOF\'\nsecret line\nEOF',
    });
    expect(detail.command).toContain("git commit -F -");
    expect(detail.command).not.toContain("secret line");
    expect(detail.command).not.toContain("c123");
  });

  test("keeps no heredoc body inside a command substitution", () => {
    const detail = refusalDetail({
      check: "attribution",
      toolKind: "shell",
      message: "refused",
      command: `git commit -m "$(cat <<'EOF'\nsecret line\nEOF\n)"\ngit log`,
    });
    expect(detail.command).not.toContain("secret line");
    expect(detail.command).toContain("git log");
  });

  test("keeps no segment of a concatenated assigned value", () => {
    const detail = refusalDetail({
      check: "attribution",
      toolKind: "shell",
      message: "refused",
      command: `ACME_TOKEN="public""acme-private"'x'y\\ z git commit`,
    });
    expect(detail.command).toBe("ACME_TOKEN=… git commit");
  });

  test("keeps no command for a refused shell write, only its paths", () => {
    const detail = refusalDetail({
      check: "artifact",
      toolKind: "shell",
      message: "refused",
      command: "printf '%s' 'acme-private' > notes.md",
      paths: ["notes.md"],
    });
    expect(detail).not.toHaveProperty("command");
    expect(detail.paths).toEqual(["notes.md"]);
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

  test("appends one refusal event when the companion selects friction", () => {
    const home = tempDir("mate-friction-home-");
    const selected = companion(["friction"]);
    record(selected, home);

    const [event] = readEvents({ sinceDays: 1, homeDir: home });
    expect(event).toMatchObject({
      kind: "refusal",
      fingerprint: "refusal:artifact:write",
      mateVersion: "unknown",
      runtime: "claude",
      sessionId: "s1",
      companion: selected,
      detail: { check: "artifact", toolKind: "write", paths: ["/acme/repo/notes.md"] },
    });
  });

  test("a refused secret read leaves neither file name nor message", () => {
    const home = tempDir("mate-friction-home-");
    record(companion(["friction"]), home, {
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

  test("returns the event's id; only a session's first refusal of a kind is first", () => {
    const home = tempDir("mate-friction-home-");
    const selected = companion(["friction"]);

    const first = record(selected, home);
    const second = record(selected, home);
    const otherSession = record(selected, home, { sessionId: "s2" });

    const [event] = readEvents({ sinceDays: 1, homeDir: home });
    expect(first).toEqual({ id: event.id, firstInSession: true });
    expect(second?.firstInSession).toBe(false);
    expect(otherSession?.firstInSession).toBe(true);
  });

  test("a companion without friction creates no folder", () => {
    const home = tempDir("mate-friction-home-");
    expect(record(companion(["rtk"]), home)).toBeNull();

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

describe("nudgeLine", () => {
  test("is one line naming the event, the report command and the way on", () => {
    const line = nudgeLine("F-12ab");

    expect(line).toContain("F-12ab");
    expect(line).toContain("mate cap friction report");
    expect(line).toContain("continue with your task");
    expect(line).not.toContain("\n");
  });
});
