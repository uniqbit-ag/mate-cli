import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isPrivateDir,
  mayReportStep,
  mayStartStep,
  sessionFileName,
  turnSession,
  turnStateDir,
} from "../runtime/turn-state.mjs";
import { mateHome } from "../runtime/runtime-directory";
import { noteShell, startTurn } from "../runtime/workflow/turn";
import { handleTurnEvent } from "./workflow-turn";

const SHIM = path.join(import.meta.dirname, "../../claude-plugin/hooks/workflow-turn.mjs");

let root: string;
let home: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-turn-state-"));
  home = path.join(root, "home");
  await fs.mkdir(path.join(home, ".mate"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("the turn state folder", () => {
  test("is the folder below Mate's home, with one sanitised file per session", () => {
    expect(turnStateDir(mateHome(home))).toBe(path.join(home, ".mate", "turn-hooks"));
    expect(sessionFileName("acme/../s 1")).toBe("acme____s_1.json");
  });

  test("is private only as a directory this user owns that no one else can enter", () => {
    const stat = (directory: boolean, uid: number, mode: number) => ({
      isDirectory: () => directory,
      uid,
      mode,
    });
    expect(isPrivateDir(stat(true, 501, 0o40700), 501)).toBe(true);
    expect(isPrivateDir(stat(true, 502, 0o40700), 501)).toBe(false);
    expect(isPrivateDir(stat(true, 501, 0o40750), 501)).toBe(false);
    expect(isPrivateDir(stat(true, 501, 0o40701), 501)).toBe(false);
    // A link reads as no directory under lstat.
    expect(isPrivateDir(stat(false, 501, 0o120700), 501)).toBe(false);
    // Without uids (Windows), only the directory is checked.
    expect(isPrivateDir(stat(true, 0, 0o40777), undefined)).toBe(true);
  });

  /** The shim and the adapter against a state folder at `home` that is not private. */
  async function refusedByBoth(planted: string) {
    const shim = spawnSync("node", [SHIM], {
      input: JSON.stringify({
        session_id: "acme-session",
        hook_event_name: "UserPromptSubmit",
        prompt: "What next?",
      }),
      encoding: "utf8",
      env: { ...process.env, HOME: home, MATE_TURN_HOOKS: "" },
    });
    // The shim clears a non-skill prompt's state only in a private folder.
    expect(shim).toMatchObject({ status: 0, stdout: "" });
    expect(await fs.stat(planted).then(() => true)).toBe(true);

    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      await expect(
        handleTurnEvent(
          { session_id: "acme-session", hook_event_name: "UserPromptSubmit", prompt: "What next?" },
          {},
          root,
        ),
      ).rejects.toThrow("is not a private directory");
    } finally {
      process.env.HOME = previous;
    }
    expect(await fs.stat(planted).then(() => true)).toBe(true);
  }

  test("the shim and the adapter never work through a folder that is a link", async () => {
    const elsewhere = path.join(root, "elsewhere");
    await fs.mkdir(elsewhere, { mode: 0o700 });
    await fs.symlink(elsewhere, turnStateDir(mateHome(home)));
    const planted = path.join(elsewhere, sessionFileName("acme-session"));
    await fs.writeFile(planted, "{}\n");
    await refusedByBoth(planted);
  });

  test("the shim and the adapter refuse a folder others can enter", async () => {
    const dir = turnStateDir(mateHome(home));
    await fs.mkdir(dir);
    await fs.chmod(dir, 0o750);
    const planted = path.join(dir, sessionFileName("acme-session"));
    await fs.writeFile(planted, "{}\n");
    await refusedByBoth(planted);
  });
});

describe("the session a command runs in", () => {
  test("is Claude Code's, else OpenCode's, else none", () => {
    expect(turnSession({ CLAUDE_CODE_SESSION_ID: "acme-claude" })).toBe("acme-claude");
    expect(turnSession({ OPENCODE_SESSION_ID: "ses_acme" })).toBe("ses_acme");
    expect(
      turnSession({ CLAUDE_CODE_SESSION_ID: "acme-claude", OPENCODE_SESSION_ID: "ses_acme" }),
    ).toBe("acme-claude");
    expect(turnSession({})).toBeUndefined();
    expect(turnSession({ CLAUDE_CODE_SESSION_ID: "", OPENCODE_SESSION_ID: "" })).toBeUndefined();
  });

  test("names its state file through the sanitizer, as the hooks do", () => {
    const session = turnSession({ OPENCODE_SESSION_ID: "../acme/s 1" });
    expect(sessionFileName(session!)).toBe("___acme_s_1.json");
  });
});

describe("the shim's prefilters", () => {
  test("let through every prompt that starts a step", () => {
    const prompts = [
      "/mate-apply-change acme-fix",
      "@mate-apply-change acme-fix",
      "$acme-security-review acme-login",
      "/skill:acme-security-review acme-login",
      "  /mate-apply-change acme-fix",
      "\t@acme-security-review 'acme-login'",
      '/mate-apply-change "acme-fix" now',
      "/mate-apply-change `acme-fix`",
      "/mate-apply-change",
      "What does apply do?",
      "please run /acme-security-review acme-login",
    ];
    const starting = prompts.filter((prompt) => startTurn(prompt).step);
    expect(starting.length).toBeGreaterThan(5);
    for (const prompt of starting) expect([prompt, mayStartStep(prompt)]).toEqual([prompt, true]);
    // A plain question stays on the fast path.
    expect(mayStartStep("What does apply do?")).toBe(false);
  });

  test("let through every command that reports a step", () => {
    const commands = [
      "mate workflow done mate-apply-change acme-fix",
      'mate workflow done mate-apply-change "acme-fix"',
      "mate workflow done 'acme-security-review' 'acme-fix'",
      "mate\tworkflow\tdone\tacme-lint\tacme-fix",
      "mate workflow done --json acme-lint acme-fix | jq .handoff",
      "/opt/acme/bin/mate workflow done acme-lint acme-fix --json",
      "mate workflow done mate-explore-change 2>&1",
      "git status && mate workflow done mate-apply-change acme-fix",
      "mate workflow done a acme-fix; mate workflow done b acme-fix",
      "mate workflow next acme-fix",
      "git status",
    ];
    const reporting = commands.filter(
      (command) => noteShell(startTurn(""), command).reports.length > 0,
    );
    expect(reporting.length).toBeGreaterThan(5);
    for (const command of reporting) {
      expect([command, mayReportStep(command)]).toEqual([command, true]);
    }
    expect(mayReportStep("git status")).toBe(false);
  });
});
