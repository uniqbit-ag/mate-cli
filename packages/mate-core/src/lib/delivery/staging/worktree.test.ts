import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { git, initRepo } from "../../../../test/git-checkouts";
import { withTemporaryWorktree } from "./worktree";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function companion(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-staging-wt-")));
  roots.push(root);
  const repo = initRepo(path.join(root, "acme-companion"));
  fs.writeFileSync(path.join(repo, "acme.md"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  return repo;
}

function worktrees(repo: string): number {
  return git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
}

describe("withTemporaryWorktree", () => {
  test("runs in a detached checkout of the ref and removes it", async () => {
    const repo = companion();
    const head = git(repo, "rev-parse", "HEAD").trim();
    let seen = "";
    const result = await withTemporaryWorktree(repo, "main", async (dir) => {
      seen = dir;
      expect(fs.readFileSync(path.join(dir, "acme.md"), "utf8")).toBe("base\n");
      return 42;
    });

    expect(result).toBe(42);
    expect(fs.existsSync(seen)).toBe(false);
    expect(worktrees(repo)).toBe(1);
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head);
  });

  test("removes the checkout when the callback throws", async () => {
    const repo = companion();
    let seen = "";
    const run = withTemporaryWorktree(repo, "main", async (dir) => {
      seen = dir;
      throw new Error("acme failure");
    });

    await expect(run).rejects.toThrow("acme failure");
    expect(fs.existsSync(seen)).toBe(false);
    expect(worktrees(repo)).toBe(1);
  });

  test("prunes a registration a crashed run left behind", async () => {
    const repo = companion();
    const stale = path.join(path.dirname(repo), "stale");
    git(repo, "worktree", "add", "-q", "--detach", stale, "main");
    fs.rmSync(stale, { recursive: true, force: true });

    await withTemporaryWorktree(repo, "main", async () => undefined);

    expect(worktrees(repo)).toBe(1);
  });

  test("refuses a ref with a symbolic link where Mate writes and removes the checkout", async () => {
    const repo = companion();
    fs.mkdirSync(path.join(repo, "openspec", "changes"), { recursive: true });
    fs.symlinkSync("/acme/outside", path.join(repo, "openspec", "changes", "archive"));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "link");
    let ran = false;

    const run = withTemporaryWorktree(repo, "main", async () => {
      ran = true;
    });

    await expect(run).rejects.toThrow("symbolic link or submodule at openspec/changes/archive");
    expect(ran).toBe(false);
    expect(worktrees(repo)).toBe(1);
  });

  test("allows a symbolic link outside Mate's content", async () => {
    const repo = companion();
    fs.symlinkSync("acme.md", path.join(repo, "acme-link.md"));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "link");

    expect(await withTemporaryWorktree(repo, "main", async () => 42)).toBe(42);
  });

  test("reports an unknown ref and leaves no directory", async () => {
    const repo = companion();
    const tmpRoot = path.join(path.dirname(repo), "tmp");
    fs.mkdirSync(tmpRoot);

    const run = withTemporaryWorktree(repo, "acme-missing", async () => undefined, { tmpRoot });

    await expect(run).rejects.toThrow("git worktree add acme-missing failed");
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });
});
