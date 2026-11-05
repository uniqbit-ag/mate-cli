import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { countTasks, readOpenChanges } from "./changes";
import { MateNotFoundError, runMateJson, shellQuote } from "./mate";
import { toPendingItems } from "./pending";
import { parseWorktrees } from "./worktrees";

describe("parseWorktrees", () => {
  test("lists worktrees, marks Workset branches, skips bare entries", () => {
    const porcelain = [
      "worktree /work/acme",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /work/acme.worktrees/queue",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/workset/acme-queue",
      "",
      "worktree /work/acme.worktrees/detached",
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
      "",
      "worktree /work/acme.git",
      "bare",
      "",
    ].join("\n");
    expect(parseWorktrees(porcelain)).toEqual([
      { path: "/work/acme", branch: "main", workset: false },
      { path: "/work/acme.worktrees/queue", branch: "workset/acme-queue", workset: true },
      { path: "/work/acme.worktrees/detached", workset: false },
    ]);
  });
});

describe("open changes", () => {
  let repo: string;
  afterEach(async () => {
    if (repo) await fs.rm(repo, { recursive: true, force: true });
  });

  test("counts task checkboxes", () => {
    expect(countTasks("- [x] 1.1 a\n- [ ] 1.2 b\n  - [X] 1.3 c\n- not a task")).toEqual({
      done: 2,
      total: 3,
    });
  });

  test("lists active changes with progress and skips archive", async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "acme-repo-"));
    const changes = path.join(repo, ".mate", "companion", "openspec", "changes");
    await fs.mkdir(path.join(changes, "archive", "2026-01-01-old"), { recursive: true });
    await fs.mkdir(path.join(changes, "acme-queue"), { recursive: true });
    await fs.writeFile(path.join(changes, "acme-queue", "proposal.md"), "# acme");
    await fs.writeFile(
      path.join(changes, "acme-queue", "tasks.md"),
      "- [x] a\n- [x] b\n- [x] c\n- [ ] d\n- [ ] e\n",
    );
    await fs.mkdir(path.join(changes, "acme-tasks-only"));
    await fs.writeFile(path.join(changes, "acme-tasks-only", "tasks.md"), "- [ ] a\n");

    expect(await readOpenChanges(repo)).toEqual({
      linked: true,
      changes: [
        {
          name: "acme-queue",
          done: 3,
          total: 5,
          file: path.join(changes, "acme-queue", "proposal.md"),
        },
        {
          name: "acme-tasks-only",
          done: 0,
          total: 1,
          file: path.join(changes, "acme-tasks-only", "tasks.md"),
        },
      ],
    });
  });

  test("reports an unlinked repository", async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "acme-repo-"));
    expect(await readOpenChanges(repo)).toEqual({ linked: false });
  });
});

describe("toPendingItems", () => {
  test("marks archives waiting for merge", () => {
    expect(
      toPendingItems({
        pending: [
          { name: "acme-queue", anchor: "2026-01-01-acme-queue", delivery: { status: "waiting" } },
          { name: "acme-done", anchor: "2026-01-02-acme-done", delivery: { status: "merged" } },
        ],
      }),
    ).toEqual([
      { name: "acme-queue", anchor: "2026-01-01-acme-queue", waitingForMerge: true },
      { name: "acme-done", anchor: "2026-01-02-acme-done", waitingForMerge: false },
    ]);
  });
});

describe("runMateJson", () => {
  test("quotes arguments and parses JSON after profile noise", async () => {
    let command = "";
    const result = await runMateJson<{ ok: boolean }>(
      ["session", "remove", "it's"],
      "/work",
      async (line) => {
        command = line;
        return { code: 0, stdout: 'motd\n{"ok": true}\n', stderr: "" };
      },
    );
    expect(command).toBe(`mate 'session' 'remove' ${shellQuote("it's")}`);
    expect(result).toEqual({ ok: true });
  });

  test("exit 127 means mate was not found and names setup", async () => {
    const error = await runMateJson(["session", "list"], "/work", async () => ({
      code: 127,
      stdout: "",
      stderr: "zsh: command not found: mate",
    })).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(MateNotFoundError);
    expect((error as Error).message).toContain("mate vscode setup");
  });

  test("other failures surface the last stderr line", async () => {
    const error = await runMateJson(["artifact", "pending"], "/work", async () => ({
      code: 1,
      stdout: "",
      stderr: "warning\nmate: no companion is linked\n",
    })).catch((caught: Error) => caught);
    expect((error as Error).message).toBe("mate: no companion is linked");
  });
});
