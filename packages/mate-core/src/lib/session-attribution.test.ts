import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { attributeCurrentSession, currentSessionId } from "./session-attribution";
import { addSession, listSessions } from "../runtime/session-registry";

let home: string;
let file: string;
let work: string;

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acme-attribution-")));
  file = path.join(home, ".mate", "sessions.json");
  work = path.join(home, "acme");
  await fs.mkdir(work);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("session attribution", () => {
  test("Claude's id wins, then OpenCode's; blank values do not count", () => {
    expect(currentSessionId({ CLAUDE_CODE_SESSION_ID: "c", OPENCODE_SESSION_ID: "o" })).toBe("c");
    expect(currentSessionId({ CLAUDE_CODE_SESSION_ID: " ", OPENCODE_SESSION_ID: "o" })).toBe("o");
    expect(currentSessionId({})).toBeNull();
  });

  test("records the change, and the worktree a move goes to", async () => {
    const wt = path.join(home, "acme-wt");
    await fs.mkdir(wt);
    await addSession({ id: "s1", runtime: "claude", cwd: work, branch: "main" }, { file });

    await attributeCurrentSession(
      { change: "acme-queue" },
      { CLAUDE_CODE_SESSION_ID: "s1" },
      { file },
    );
    expect((await listSessions(file)).sessions[0]).toMatchObject({
      change: "acme-queue",
      cwd: work,
    });

    await attributeCurrentSession(
      { change: "acme-queue", move: { cwd: wt, branch: "workset/acme" } },
      { CLAUDE_CODE_SESSION_ID: "s1" },
      { file },
    );
    expect((await listSessions(file)).sessions[0]).toMatchObject({
      change: "acme-queue",
      cwd: wt,
      branch: "workset/acme",
    });
  });

  test("outside a session or for an unregistered id nothing changes", async () => {
    expect(await attributeCurrentSession({ change: "acme" }, {}, { file })).toBeNull();
    expect(
      await attributeCurrentSession({ change: "acme" }, { OPENCODE_SESSION_ID: "nope" }, { file }),
    ).toBeNull();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{broken");
    expect(
      await attributeCurrentSession({ change: "acme" }, { OPENCODE_SESSION_ID: "x" }, { file }),
    ).toBeNull();
  });
});
