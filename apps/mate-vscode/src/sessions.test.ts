import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { repositoryRoots, resolveRepository } from "./repository";
import { umbrellaFixture } from "./umbrella.fixture";

import {
  attachable,
  attachCommand,
  daemonId,
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
    expect(launchCommand(opencode)).toBe(`mate opencode -- --bg --session ${opencode.id}`);
    expect(resumeCommand(opencode)).toBe(`mate opencode -- --bg --session ${opencode.id}`);
  });

  test("attach per runtime", () => {
    expect(attachCommand(claude)).toBe("claude attach 0b7c1d2e");
    expect(attachCommand(opencode)).toBe(`mate opencode -- --bg --session ${opencode.id}`);
  });

  test("the daemon id Mate listed wins over the id's prefix", () => {
    expect(daemonId(claude)).toBe("0b7c1d2e");
    expect(daemonId({ ...claude, daemonId: "acme1234" })).toBe("acme1234");
    expect(attachCommand({ ...claude, daemonId: "acme1234" })).toBe("claude attach acme1234");
  });

  test("only background sessions can be attached and stopped", () => {
    const running = { ...claude, state: "running" as const };
    expect(attachable({ ...running, kind: "background" })).toBe(true);
    expect(attachable({ ...running, kind: "interactive" })).toBe(false);
    expect(attachable({ ...opencode, state: "running" })).toBe(true);
    expect(attachable({ ...opencode, state: "parked" })).toBe(false);
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

  test("an umbrella spans itself, its children, their worktrees, and its mirrored worktrees", async () => {
    const acme = await umbrellaFixture();
    try {
      const repository = await resolveRepository(acme.umbrella);
      if (repository?.kind !== "umbrella") throw new Error("Fixture must be an umbrella");
      const roots = await repositoryRoots(repository);
      expect(roots).toEqual(
        expect.arrayContaining([acme.umbrella, acme.api, acme.web, acme.scratch, acme.mirrored]),
      );
      const at = (id: string, cwd: string): Session => ({ ...claude, id, cwd });
      const listed = sessionsForRepository(
        [
          at("umbrella", acme.umbrella),
          at("api", acme.api),
          at("mirrored", path.join(acme.mirrored, "web")),
          at("scratch", acme.scratch),
          at("other", acme.plain),
        ],
        roots,
      );
      expect(listed.map((session) => session.id)).toEqual([
        "umbrella",
        "api",
        "mirrored",
        "scratch",
      ]);
    } finally {
      await fs.rm(acme.root, { recursive: true, force: true });
    }
  });
});
