import { describe, expect, test } from "bun:test";

import {
  isSessionTerminal,
  launchCommand,
  opencodeSessionId,
  parseTerminalName,
  resumeCommand,
  sessionsForRepository,
  terminalName,
  type Session,
} from "./sessions";

const claude: Session = {
  id: "0b7c1d2e-0000-4000-8000-00000000acme",
  runtime: "claude",
  cwd: "/work/acme",
  startedAt: "2026-01-01T00:00:00Z",
};
const opencode: Session = {
  id: "ses_e596da077ffeAcmeAcmeAcme01",
  runtime: "opencode",
  cwd: "/work/acme.worktrees/feature",
  startedAt: "2026-01-02T00:00:00Z",
};

describe("opencodeSessionId", () => {
  test("has OpenCode's form", () => {
    expect(opencodeSessionId()).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  test("newer ids sort first, as OpenCode's do", () => {
    const random = new Uint8Array(14);
    expect(opencodeSessionId(2_000, random) < opencodeSessionId(1_000, random)).toBe(true);
  });
});

describe("terminal names", () => {
  test("round-trip runtime and short id", () => {
    expect(terminalName(claude)).toBe("Mate claude · 0000acme");
    expect(parseTerminalName(terminalName(opencode))).toEqual({
      runtime: "opencode",
      shortId: "meAcme01",
    });
    expect(parseTerminalName("zsh")).toBeNull();
  });

  test("match only their own session", () => {
    expect(isSessionTerminal(claude, terminalName(claude))).toBe(true);
    expect(isSessionTerminal(opencode, terminalName(claude))).toBe(false);
  });
});

describe("command lines", () => {
  test("launch and resume per runtime", () => {
    expect(launchCommand(claude)).toBe(`mate claude -- --session-id ${claude.id}`);
    expect(resumeCommand(claude)).toBe(`mate claude -- --resume ${claude.id}`);
    expect(launchCommand(opencode)).toBe(`mate opencode -- --session ${opencode.id}`);
    expect(resumeCommand(opencode)).toBe(`mate opencode -- --session ${opencode.id}`);
  });
});

describe("sessionsForRepository", () => {
  test("keeps sessions in the repository or its worktrees", () => {
    const other = { ...claude, id: "other", cwd: "/work/acme-other" };
    const nested = { ...claude, id: "nested", cwd: "/work/acme/packages/core" };
    expect(
      sessionsForRepository(
        [claude, opencode, other, nested],
        ["/work/acme", "/work/acme.worktrees/feature"],
      ).map((session) => session.id),
    ).toEqual([claude.id, opencode.id, "nested"]);
  });
});
