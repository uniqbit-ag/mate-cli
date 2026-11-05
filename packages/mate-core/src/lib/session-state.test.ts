import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { addSession, endSession, listSessions, patchSession } from "../runtime/session-registry";
import {
  listSessionsWithState,
  readFirstPrompt,
  shortenLabel,
  type ClaudeAgent,
  type SessionStateDeps,
} from "./session-state";

let home: string;
let file: string;
let work: string;

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acme-session-state-")));
  file = path.join(home, ".mate", "sessions.json");
  work = path.join(home, "acme");
  await fs.mkdir(work);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const at = (iso: string) => () => new Date(iso);
const NOW = at("2026-03-01T00:00:00.000Z");

function deps(overrides: SessionStateDeps = {}): SessionStateDeps {
  return {
    now: NOW,
    claudeAgents: async () => [],
    isAlive: () => false,
    isMerged: async () => false,
    readFirstPrompt: async () => null,
    ...overrides,
  };
}

async function list(overrides: SessionStateDeps = {}) {
  return (await listSessionsWithState({ file, ...deps(overrides) })).sessions;
}

describe("session state", () => {
  test("Claude: background blocked is running and waiting; unlisted is parked", async () => {
    await addSession({ id: "bg", runtime: "claude", cwd: work }, { file });
    await addSession({ id: "gone", runtime: "claude", cwd: work, pid: 99 }, { file });
    const agents: ClaudeAgent[] = [
      { id: "bg-short", sessionId: "bg", kind: "background", state: "blocked" },
    ];
    const sessions = await list({ claudeAgents: async () => agents, isAlive: () => true });
    expect(sessions.find((s) => s.id === "bg")).toMatchObject({
      state: "running",
      activity: "waiting",
      kind: "background",
      daemonId: "bg-short",
    });
    expect(sessions.find((s) => s.id === "gone")).toMatchObject({ state: "parked" });
  });

  test("Claude: busy interactive is working; a done background session is parked", async () => {
    await addSession({ id: "i", runtime: "claude", cwd: work }, { file });
    await addSession({ id: "d", runtime: "claude", cwd: work }, { file });
    const agents: ClaudeAgent[] = [
      { sessionId: "i", kind: "interactive", status: "busy" },
      { sessionId: "d", kind: "background", state: "done" },
    ];
    const sessions = await list({ claudeAgents: async () => agents });
    expect(sessions.find((s) => s.id === "i")).toMatchObject({
      state: "running",
      activity: "working",
      kind: "interactive",
    });
    expect(sessions.find((s) => s.id === "i")?.daemonId).toBeUndefined();
    expect(sessions.find((s) => s.id === "d")?.state).toBe("parked");
    expect(sessions.find((s) => s.id === "d")?.activity).toBeUndefined();
  });

  test("pid fallback without claude agents and for OpenCode", async () => {
    await addSession({ id: "c", runtime: "claude", cwd: work, pid: 1 }, { file });
    await addSession({ id: "o", runtime: "opencode", cwd: work, pid: 2 }, { file });
    await addSession({ id: "e", runtime: "opencode", cwd: work, pid: 3 }, { file });
    await endSession("e", { file });
    const sessions = await list({ claudeAgents: async () => null, isAlive: () => true });
    expect(Object.fromEntries(sessions.map((s) => [s.id, s.state]))).toEqual({
      c: "running",
      o: "running",
      e: "parked",
    });
  });

  test("OpenCode: stored activity shows only while the session runs", async () => {
    await addSession({ id: "o", runtime: "opencode", cwd: work, pid: 2 }, { file });
    await addSession({ id: "e", runtime: "opencode", cwd: work, pid: 3 }, { file });
    await patchSession("o", { activity: "waiting" }, { file });
    await patchSession("e", { activity: "working" }, { file });
    const sessions = await list({ isAlive: (pid) => pid === 2 });
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    expect(byId.o).toMatchObject({ state: "running", activity: "waiting" });
    expect(byId.e?.state).toBe("parked");
    expect(byId.e?.activity).toBeUndefined();
  });

  test("a session without pid and endedAt is parked", async () => {
    await addSession({ id: "o", runtime: "opencode", cwd: work }, { file });
    expect((await list())[0]?.state).toBe("parked");
  });

  test("done when the directory is gone or the branch is merged", async () => {
    const wt = path.join(home, "acme-wt");
    await fs.mkdir(wt);
    await addSession({ id: "wt", runtime: "claude", cwd: wt }, { file });
    await addSession({ id: "m", runtime: "claude", cwd: work, branch: "workset/acme" }, { file });
    await addSession(
      { id: "open", runtime: "claude", cwd: work, branch: "workset/next" },
      { file },
    );
    await fs.rm(wt, { recursive: true });
    const sessions = await list({
      isMerged: async (_cwd, branch) => branch === "workset/acme",
    });
    expect(Object.fromEntries(sessions.map((s) => [s.id, s.state]))).toEqual({
      wt: "done",
      m: "done",
      open: "parked",
    });
  });

  test("a running session on a merged branch stays running", async () => {
    await addSession({ id: "m", runtime: "claude", cwd: work, branch: "workset/acme" }, { file });
    await addSession(
      { id: "o", runtime: "opencode", cwd: work, branch: "workset/acme", pid: 2 },
      { file },
    );
    const agents: ClaudeAgent[] = [{ sessionId: "m", kind: "background", state: "working" }];
    const sessions = await list({
      claudeAgents: async () => agents,
      isAlive: () => true,
      isMerged: async () => true,
    });
    expect(Object.fromEntries(sessions.map((s) => [s.id, s.state]))).toEqual({
      m: "running",
      o: "running",
    });
  });

  test("a failing merge check leaves the session not done", async () => {
    await addSession({ id: "m", runtime: "claude", cwd: work, branch: "workset/acme" }, { file });
    const sessions = await list({
      isMerged: async () => {
        throw new Error("git broke");
      },
    });
    expect(sessions[0]?.state).toBe("parked");
  });

  test("done sessions last seen over 30 days ago are pruned; recent ones are kept", async () => {
    await addSession(
      { id: "old", runtime: "claude", cwd: work, branch: "workset/acme" },
      { file, now: at("2026-01-15T00:00:00.000Z") },
    );
    await addSession(
      { id: "new", runtime: "claude", cwd: work, branch: "workset/acme" },
      { file, now: at("2026-02-28T00:00:00.000Z") },
    );
    await addSession(
      { id: "parked", runtime: "claude", cwd: work },
      { file, now: at("2026-01-01T00:00:00.000Z") },
    );
    const sessions = await list({ isMerged: async () => true });
    expect(sessions.map((s) => s.id)).toEqual(["new", "parked"]);
    expect((await listSessions(file)).sessions.map((s) => s.id)).toEqual(["new", "parked"]);
  });

  test("a missing label is filled from the transcript once and stored", async () => {
    await addSession({ id: "s", runtime: "claude", cwd: work, transcript: "/t/s.jsonl" }, { file });
    let reads = 0;
    const readPrompt = async () => {
      reads += 1;
      return "How does the queue\nretry work?";
    };
    expect((await list({ readFirstPrompt: readPrompt }))[0]?.label).toBe(
      "How does the queue retry work?",
    );
    expect((await listSessions(file)).sessions[0]?.label).toBe("How does the queue retry work?");
    await list({ readFirstPrompt: readPrompt });
    expect(reads).toBe(1);
  });

  test("a busy registry lock still lists, and leaves the label for later", async () => {
    await addSession({ id: "s", runtime: "claude", cwd: work, transcript: "/t/s.jsonl" }, { file });
    await fs.writeFile(`${file}.lock`, "other");
    const sessions = (
      await listSessionsWithState({
        file,
        lock: { waitMs: 50 },
        ...deps({ readFirstPrompt: async () => "Queue retries" }),
      })
    ).sessions;
    expect(sessions[0]?.label).toBe("Queue retries");
    expect((await listSessions(file)).sessions[0]?.label).toBeUndefined();
  });

  test("listing does not rewrite an unchanged registry", async () => {
    await addSession({ id: "s", runtime: "claude", cwd: work }, { file });
    const before = await fs.stat(file);
    await list();
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
  });
});

describe("transcript prompts", () => {
  test("first real user prompt, skipping meta, command, and tool-result lines", async () => {
    const transcript = path.join(home, "s.jsonl");
    const lines = [
      { type: "summary", summary: "x" },
      { type: "user", isMeta: true, message: { role: "user", content: "meta" } },
      { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "out" }] },
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "  Explain the acme queue  " }] },
      },
      { type: "user", message: { role: "user", content: "second" } },
    ];
    await fs.writeFile(transcript, lines.map((line) => JSON.stringify(line)).join("\n"));
    expect(await readFirstPrompt(transcript)).toBe("Explain the acme queue");
  });

  test("missing transcript or no prompt yet", async () => {
    expect(await readFirstPrompt(path.join(home, "none.jsonl"))).toBeNull();
    const empty = path.join(home, "empty.jsonl");
    await fs.writeFile(empty, "");
    expect(await readFirstPrompt(empty)).toBeNull();
  });

  test("labels are one line and at most 200 characters", () => {
    expect(shortenLabel("a\n b")).toBe("a b");
    const long = shortenLabel("x".repeat(300));
    expect(long).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("branch merge check (real Git)", () => {
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "acme",
        GIT_AUTHOR_EMAIL: "acme@example.com",
        GIT_COMMITTER_NAME: "acme",
        GIT_COMMITTER_EMAIL: "acme@example.com",
      },
    });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.toString().trim();
  };

  async function repository() {
    const origin = path.join(home, "origin.git");
    const clone = path.join(home, "clone");
    git(home, "init", "--bare", "-b", "main", origin);
    git(home, "clone", origin, clone);
    git(clone, "checkout", "-b", "main");
    await fs.writeFile(path.join(clone, "a.txt"), "a\n");
    git(clone, "add", ".");
    git(clone, "commit", "-m", "init");
    git(clone, "push", "-u", "origin", "main");
    git(clone, "remote", "set-head", "origin", "main");
    return clone;
  }

  test("fresh branch is not merged; merge commit and squash are", async () => {
    const { branchMerged } = await import("./session-state");
    const clone = await repository();

    git(clone, "branch", "workset/fresh");
    expect(await branchMerged(clone, "workset/fresh")).toBe(false);

    git(clone, "checkout", "-b", "workset/merged");
    await fs.writeFile(path.join(clone, "b.txt"), "b\n");
    git(clone, "add", ".");
    git(clone, "commit", "-m", "b");
    git(clone, "checkout", "main");
    expect(await branchMerged(clone, "workset/merged")).toBe(false);
    git(clone, "merge", "--no-ff", "-m", "merge", "workset/merged");
    git(clone, "push", "origin", "main");
    expect(await branchMerged(clone, "workset/merged")).toBe(true);

    git(clone, "checkout", "-b", "workset/squashed");
    await fs.writeFile(path.join(clone, "c.txt"), "c\n");
    git(clone, "add", ".");
    git(clone, "commit", "-m", "c");
    git(clone, "checkout", "main");
    git(clone, "merge", "--squash", "workset/squashed");
    git(clone, "commit", "-m", "squash c");
    git(clone, "push", "origin", "main");
    expect(await branchMerged(clone, "workset/squashed")).toBe(true);

    expect(await branchMerged(clone, "main")).toBe(false);

    git(clone, "branch", "-D", "workset/merged");
    expect(await branchMerged(clone, "workset/merged")).toBe(true);
  });

  test("a missing branch outside a repository is not merged", async () => {
    const { branchMerged } = await import("./session-state");
    expect(await branchMerged(work, "workset/acme")).toBe(false);
  });
});
