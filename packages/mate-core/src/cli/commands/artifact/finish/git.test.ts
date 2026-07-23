import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { defaultGitOps } from "./git";

const tempRoots: string[] = [];

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trim();
}

function configureGit(cwd: string): void {
  git(cwd, ["config", "user.name", "Mate"]);
  git(cwd, ["config", "user.email", "mate@example.test"]);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("defaultGitOps", () => {
  test("rejects a working repo passed as the companion target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);
    git(root, ["init", "-q"]);

    expect(() => defaultGitOps(root, root)).toThrow("companion and working repo are identical");
  });

  test("rejects a path that is not a standalone Git root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);

    expect(() => defaultGitOps(root)).toThrow("companion is not a Git root");
  });

  test("preserves the first porcelain path for an unstaged modification", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);
    const filePath = path.join(root, "openspec", "specs", "example", "spec.md");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "before\n", "utf8");
    git(root, ["init", "-q"]);
    configureGit(root);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "initial"]);
    await fs.writeFile(filePath, "after\n", "utf8");

    await expect(defaultGitOps(root).changedPaths()).resolves.toEqual([
      "openspec/specs/example/spec.md",
    ]);
  });

  test("reports only paths already staged in the index", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);
    await fs.writeFile(path.join(root, "staged.txt"), "before\n", "utf8");
    await fs.writeFile(path.join(root, "unstaged.txt"), "before\n", "utf8");
    git(root, ["init", "-q"]);
    configureGit(root);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "initial"]);
    await fs.writeFile(path.join(root, "staged.txt"), "after\n", "utf8");
    await fs.writeFile(path.join(root, "unstaged.txt"), "after\n", "utf8");
    git(root, ["add", "staged.txt"]);

    await expect(defaultGitOps(root).stagedPaths()).resolves.toEqual(["staged.txt"]);
  });

  test("rebase autostashes and restores unrelated tracked work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const local = path.join(root, "local");
    const other = path.join(root, "other");
    git(root, ["init", "--bare", "-q", remote]);
    git(root, ["clone", "-q", remote, seed]);
    configureGit(seed);
    await fs.writeFile(path.join(seed, "finish.txt"), "base\n", "utf8");
    await fs.writeFile(path.join(seed, "dirty.txt"), "base\n", "utf8");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-qm", "base"]);
    git(seed, ["push", "-qu", "origin", "HEAD"]);
    git(root, ["clone", "-q", remote, local]);
    git(root, ["clone", "-q", remote, other]);
    configureGit(local);
    configureGit(other);
    await fs.writeFile(path.join(other, "remote.txt"), "remote\n", "utf8");
    git(other, ["add", "."]);
    git(other, ["commit", "-qm", "remote"]);
    git(other, ["push", "-q"]);
    await fs.writeFile(path.join(local, "finish.txt"), "finished\n", "utf8");
    git(local, ["add", "finish.txt"]);
    git(local, ["commit", "-qm", "finish"]);
    await fs.writeFile(path.join(local, "dirty.txt"), "preserved\n", "utf8");
    await fs.writeFile(path.join(local, "untracked.txt"), "preserved\n", "utf8");

    const ops = defaultGitOps(local);
    await ops.fetch();
    await expect(ops.rebaseOntoUpstream()).resolves.toEqual({ ok: true, conflictedPaths: [] });
    await expect(fs.readFile(path.join(local, "dirty.txt"), "utf8")).resolves.toBe("preserved\n");
    await expect(fs.readFile(path.join(local, "untracked.txt"), "utf8")).resolves.toBe(
      "preserved\n",
    );
  });

  test("add ignores exact pathspecs that no longer exist or have tracked deletions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);
    git(root, ["init", "-q"]);

    await expect(defaultGitOps(root).add(["openspec/changes/missing"])).resolves.toBeUndefined();
  });

  test("commit pathspec leaves unrelated staged work in the index", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);
    await fs.writeFile(path.join(root, "finish.txt"), "before\n", "utf8");
    await fs.writeFile(path.join(root, "unrelated.txt"), "before\n", "utf8");
    git(root, ["init", "-q"]);
    configureGit(root);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "initial"]);

    await fs.writeFile(path.join(root, "finish.txt"), "finished\n", "utf8");
    await fs.writeFile(path.join(root, "unrelated.txt"), "unrelated\n", "utf8");
    git(root, ["add", "unrelated.txt"]);

    const ops = defaultGitOps(root);
    await ops.add(["finish.txt"]);
    await expect(ops.hasStagedChanges(["finish.txt"])).resolves.toBe(true);
    await ops.commit("finish", ["finish.txt"]);

    expect(gitOutput(root, ["show", "--format=", "--name-only", "HEAD"])).toBe("finish.txt");
    expect(gitOutput(root, ["diff", "--cached", "--name-only"])).toBe("unrelated.txt");
  });

  test("commit tolerates a pathspec for a never-tracked path that was moved away", async () => {
    // Reproduces a finish over a change dir that was created and archived within one
    // session: the active dir was never committed, so after `openspec archive` moves it,
    // its pathspec is unknown to git and must not abort the commit.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);
    git(root, ["init", "-q"]);
    configureGit(root);
    await fs.writeFile(path.join(root, "seed.txt"), "seed\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "initial"]);

    const archived = path.join(root, "openspec", "changes", "archive", "2026-07-14-my-change");
    await fs.mkdir(archived, { recursive: true });
    await fs.writeFile(path.join(archived, "proposal.md"), "archived\n", "utf8");

    const ops = defaultGitOps(root);
    const commitPaths = [
      "openspec/changes/my-change", // never tracked, already moved away by produce
      "openspec/changes/archive/2026-07-14-my-change",
    ];
    await ops.add(commitPaths);
    await expect(ops.hasStagedChanges(commitPaths)).resolves.toBe(true);
    await ops.commit("finish", commitPaths);

    expect(gitOutput(root, ["show", "--format=", "--name-only", "HEAD"])).toBe(
      "openspec/changes/archive/2026-07-14-my-change/proposal.md",
    );
  });

  test("restorePaths cleans produced tracked and untracked paths only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);
    await fs.writeFile(path.join(root, "produced.txt"), "before\n", "utf8");
    await fs.writeFile(path.join(root, "unrelated.txt"), "before\n", "utf8");
    git(root, ["init", "-q"]);
    configureGit(root);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "initial"]);

    await fs.writeFile(path.join(root, "produced.txt"), "changed\n", "utf8");
    await fs.mkdir(path.join(root, "archive", "nested"), { recursive: true });
    await fs.writeFile(path.join(root, "archive", "nested", "proposal.md"), "archive\n", "utf8");
    await fs.writeFile(path.join(root, "unrelated.txt"), "preserved\n", "utf8");

    await defaultGitOps(root).restorePaths("HEAD", ["produced.txt", "archive"]);

    expect(await fs.readFile(path.join(root, "produced.txt"), "utf8")).toBe("before\n");
    await expect(fs.access(path.join(root, "archive"))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "unrelated.txt"), "utf8")).toBe("preserved\n");
  });
});
