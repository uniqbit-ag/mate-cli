import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { CompanionGitSync, CompanionGitSyncError } from "./companion-git-sync";

const tempRoots: string[] = [];
const managedRoots = [".mate", ".opencode", ".claude", ".agents", ".graphify"];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function makeRepository(): Promise<{ root: string; companion: string; upstream: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-companion-git-"));
  tempRoots.push(root);
  const remote = path.join(root, "remote.git");
  const companion = path.join(root, "companion");
  const upstream = path.join(root, "upstream");

  git(root, "init", "--bare", "-q", "--initial-branch=main", remote);
  await fs.mkdir(companion);
  git(companion, "init", "-q", "--initial-branch=main");
  git(companion, "config", "user.email", "mate-tests@example.com");
  git(companion, "config", "user.name", "Mate Tests");
  await Promise.all(managedRoots.map((root) => fs.mkdir(path.join(companion, root))));
  await Promise.all(
    managedRoots.map((root) => fs.writeFile(path.join(companion, root, "managed.md"), "base\n")),
  );
  await fs.writeFile(path.join(companion, "notes.md"), "base\n");
  await fs.writeFile(
    path.join(companion, ".gitignore"),
    ".mate/ignored.local\n.graphify/ignored.local\n",
  );
  git(companion, "add", ".");
  git(companion, "commit", "-qm", "base");
  git(companion, "remote", "add", "origin", remote);
  git(companion, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", remote, upstream);
  git(upstream, "config", "user.email", "mate-tests@example.com");
  git(upstream, "config", "user.name", "Mate Tests");

  return { root, companion, upstream };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("CompanionGitSync", () => {
  test("skips a non-Git companion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-non-git-"));
    tempRoots.push(root);

    await expect(new CompanionGitSync().sync(root)).resolves.toEqual({
      skipped: true,
      changed: false,
      companionPath: root,
    });
  });

  test("rejects a working repository as the companion Git target", async () => {
    const { companion } = await makeRepository();

    await expect(new CompanionGitSync().sync(companion, companion)).rejects.toMatchObject({
      name: "CompanionGitSyncError",
      message: expect.stringContaining("companion and working repo are identical"),
    });
  });

  test("rejects a directory inside a Git worktree", async () => {
    const { companion } = await makeRepository();

    await expect(new CompanionGitSync().sync(path.join(companion, ".mate"))).rejects.toMatchObject({
      name: "CompanionGitSyncError",
      message: expect.stringContaining("companion is not a Git root"),
    });
  });

  test("ignores Git environment overrides when synchronizing", async () => {
    const { root, companion, upstream } = await makeRepository();
    const previousEnv = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    };
    const unrelated = path.join(root, "unrelated");
    await fs.mkdir(unrelated);
    git(unrelated, "init", "-q", "--initial-branch=main");
    git(unrelated, "config", "user.email", "mate-tests@example.com");
    git(unrelated, "config", "user.name", "Mate Tests");
    await fs.writeFile(path.join(unrelated, "unrelated.md"), "unrelated\n");
    git(unrelated, "add", "unrelated.md");
    git(unrelated, "commit", "-qm", "unrelated");
    await fs.writeFile(path.join(upstream, "remote.md"), "remote\n");
    git(upstream, "add", "remote.md");
    git(upstream, "commit", "-qm", "remote");
    git(upstream, "push", "-q");

    process.env.GIT_DIR = path.join(unrelated, ".git");
    process.env.GIT_WORK_TREE = unrelated;
    process.env.GIT_COMMON_DIR = path.join(unrelated, ".git");
    process.env.GIT_INDEX_FILE = path.join(unrelated, "index");
    try {
      await new CompanionGitSync().sync(companion);
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(await fs.readFile(path.join(companion, "remote.md"), "utf8")).toBe("remote\n");
    await expect(fs.access(path.join(unrelated, "remote.md"))).rejects.toThrow();
  });

  test("fetches and fast-forwards a companion behind origin/main", async () => {
    const { companion, upstream } = await makeRepository();
    await fs.writeFile(path.join(upstream, "remote.md"), "remote\n");
    git(upstream, "add", "remote.md");
    git(upstream, "commit", "-qm", "remote");
    git(upstream, "push", "-q");

    await new CompanionGitSync().sync(companion);

    expect(git(companion, "rev-parse", "HEAD")).toBe(git(companion, "rev-parse", "origin/main"));
    expect(await fs.readFile(path.join(companion, "remote.md"), "utf8")).toBe("remote\n");
  });

  test("uses the configured upstream instead of assuming origin/main", async () => {
    const { companion, upstream } = await makeRepository();
    git(upstream, "checkout", "-qb", "stable");
    await fs.writeFile(path.join(upstream, "stable.md"), "stable base\n");
    git(upstream, "add", "stable.md");
    git(upstream, "commit", "-qm", "stable base");
    git(upstream, "push", "-q", "-u", "origin", "stable");
    git(companion, "fetch", "-q", "origin", "stable");
    git(companion, "branch", "--set-upstream-to=origin/stable", "main");

    await fs.writeFile(path.join(upstream, "stable-update.md"), "from stable\n");
    git(upstream, "add", "stable-update.md");
    git(upstream, "commit", "-qm", "stable update");
    git(upstream, "push", "-q");

    await new CompanionGitSync().sync(companion);

    expect(await fs.readFile(path.join(companion, "stable-update.md"), "utf8")).toBe(
      "from stable\n",
    );
  });

  test("creates a merge commit for divergent artifact commits", async () => {
    const { companion, upstream } = await makeRepository();
    await fs.writeFile(path.join(companion, "local.md"), "local\n");
    git(companion, "add", "local.md");
    git(companion, "commit", "-qm", "local");
    await fs.writeFile(path.join(upstream, "remote.md"), "remote\n");
    git(upstream, "add", "remote.md");
    git(upstream, "commit", "-qm", "remote");
    git(upstream, "push", "-q");

    await new CompanionGitSync().sync(companion);

    expect(git(companion, "rev-list", "--count", "--merges", "HEAD")).toBe("1");
    expect(await fs.readFile(path.join(companion, "local.md"), "utf8")).toBe("local\n");
    expect(await fs.readFile(path.join(companion, "remote.md"), "utf8")).toBe("remote\n");
  });

  test("preserves unmanaged changes while replacing managed changes and ignored files", async () => {
    const { companion, upstream } = await makeRepository();
    await fs.writeFile(path.join(companion, "notes.md"), "local notes\n");
    await fs.writeFile(path.join(companion, "local-untracked.md"), "keep this artifact\n");
    await fs.writeFile(path.join(companion, ".mate", "managed.md"), "local managed\n");
    await fs.writeFile(path.join(companion, ".opencode", "managed.md"), "local opencode\n");
    await fs.writeFile(path.join(companion, ".claude", "managed.md"), "local claude\n");
    await fs.writeFile(path.join(companion, ".agents", "managed.md"), "local agents\n");
    await fs.writeFile(path.join(companion, ".graphify", "managed.md"), "local graphify\n");
    await fs.writeFile(path.join(companion, ".mate", "ignored.local"), "keep me\n");
    await fs.writeFile(path.join(companion, ".graphify", "ignored.local"), "keep graphify\n");
    await fs.writeFile(path.join(upstream, ".mate", "managed.md"), "remote managed\n");
    await fs.writeFile(path.join(upstream, ".opencode", "managed.md"), "remote opencode\n");
    await fs.writeFile(path.join(upstream, ".claude", "managed.md"), "remote claude\n");
    await fs.writeFile(path.join(upstream, ".agents", "managed.md"), "remote agents\n");
    await fs.writeFile(path.join(upstream, ".graphify", "managed.md"), "remote graphify\n");
    git(
      upstream,
      "add",
      ".mate/managed.md",
      ".opencode/managed.md",
      ".claude/managed.md",
      ".agents/managed.md",
      ".graphify/managed.md",
    );
    git(upstream, "commit", "-qm", "managed update");
    git(upstream, "push", "-q");

    await new CompanionGitSync().sync(companion);

    expect(await fs.readFile(path.join(companion, "notes.md"), "utf8")).toBe("local notes\n");
    expect(await fs.readFile(path.join(companion, "local-untracked.md"), "utf8")).toBe(
      "keep this artifact\n",
    );
    expect(await fs.readFile(path.join(companion, ".mate", "managed.md"), "utf8")).toBe(
      "remote managed\n",
    );
    expect(await fs.readFile(path.join(companion, ".opencode", "managed.md"), "utf8")).toBe(
      "remote opencode\n",
    );
    expect(await fs.readFile(path.join(companion, ".claude", "managed.md"), "utf8")).toBe(
      "remote claude\n",
    );
    expect(await fs.readFile(path.join(companion, ".agents", "managed.md"), "utf8")).toBe(
      "remote agents\n",
    );
    expect(await fs.readFile(path.join(companion, ".graphify", "managed.md"), "utf8")).toBe(
      "remote graphify\n",
    );
    expect(await fs.readFile(path.join(companion, ".mate", "ignored.local"), "utf8")).toBe(
      "keep me\n",
    );
    expect(await fs.readFile(path.join(companion, ".graphify", "ignored.local"), "utf8")).toBe(
      "keep graphify\n",
    );
  });

  test("reports unresolved unmanaged conflicts", async () => {
    const { companion, upstream } = await makeRepository();
    await fs.writeFile(path.join(companion, "notes.md"), "local\n");
    git(companion, "add", "notes.md");
    git(companion, "commit", "-qm", "local notes");
    await fs.writeFile(path.join(upstream, "notes.md"), "remote\n");
    git(upstream, "add", "notes.md");
    git(upstream, "commit", "-qm", "remote notes");
    git(upstream, "push", "-q");

    await expect(new CompanionGitSync().sync(companion)).rejects.toMatchObject({
      name: "CompanionGitSyncError",
      conflictingPaths: ["notes.md"],
    });
  });

  test("reports conflicts while reapplying unmanaged dirty changes", async () => {
    const { companion, upstream } = await makeRepository();
    await fs.writeFile(path.join(companion, "notes.md"), "local dirty\n");
    await fs.writeFile(path.join(upstream, "notes.md"), "remote\n");
    git(upstream, "add", "notes.md");
    git(upstream, "commit", "-qm", "remote notes");
    git(upstream, "push", "-q");

    await expect(new CompanionGitSync().sync(companion)).rejects.toMatchObject({
      name: "CompanionGitSyncError",
      conflictingPaths: ["notes.md"],
    });
  });

  test("blocks when an unmanaged untracked artifact collides during reapplication", async () => {
    const { companion, upstream } = await makeRepository();
    await fs.writeFile(path.join(companion, "collision.md"), "local artifact\n");
    await fs.writeFile(path.join(upstream, "collision.md"), "remote tracked\n");
    git(upstream, "add", "collision.md");
    git(upstream, "commit", "-qm", "remote collision");
    git(upstream, "push", "-q");

    await expect(new CompanionGitSync().sync(companion)).rejects.toMatchObject({
      name: "CompanionGitSyncError",
    });
  });

  test("reports unfinished operations and fetch failures", async () => {
    const { companion } = await makeRepository();
    const gitDir = git(companion, "rev-parse", "--git-dir");
    await fs.writeFile(
      path.join(companion, gitDir, "MERGE_HEAD"),
      git(companion, "rev-parse", "HEAD"),
    );
    await expect(new CompanionGitSync().sync(companion)).rejects.toBeInstanceOf(
      CompanionGitSyncError,
    );
    await fs.rm(path.join(companion, gitDir, "MERGE_HEAD"));
    git(companion, "remote", "set-url", "origin", path.join(companion, "missing.git"));
    await expect(new CompanionGitSync().sync(companion)).rejects.toBeInstanceOf(
      CompanionGitSyncError,
    );
  });
});
