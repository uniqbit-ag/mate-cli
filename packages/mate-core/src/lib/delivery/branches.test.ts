import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { classifyBranch, configuredProtectedPatterns, workingRepoGit } from "./branches";

describe("classifyBranch", () => {
  test("the default branch is protected", () => {
    expect(classifyBranch("main", { defaultBranch: "main", patterns: [] })).toEqual({
      protected: true,
      reason: "default",
    });
  });

  test("a branch matching a configured pattern is protected", () => {
    const options = { defaultBranch: "main", patterns: ["release/*", "develop"] };
    expect(classifyBranch("release/1.2", options)).toEqual({ protected: true, reason: "pattern" });
    expect(classifyBranch("develop", options)).toEqual({ protected: true, reason: "pattern" });
    expect(classifyBranch("release", options).protected).toBe(false);
  });

  test("a feature branch is not protected", () => {
    expect(
      classifyBranch("change/add-graph", { defaultBranch: "main", patterns: ["release/*"] }),
    ).toEqual({ protected: false, reason: null });
  });

  test("a single star does not cross a slash, a double star does", () => {
    expect(
      classifyBranch("release/a/b", { defaultBranch: "x", patterns: ["release/*"] }).protected,
    ).toBe(false);
    expect(
      classifyBranch("release/a/b", { defaultBranch: "x", patterns: ["release/**"] }).protected,
    ).toBe(true);
  });
});

describe("configuredProtectedPatterns", () => {
  test("reads the openspec capability's patterns and ignores other capabilities", () => {
    expect(
      configuredProtectedPatterns([
        { name: "rtk" },
        { name: "openspec", protectedBranches: ["release/*", 3 as unknown as string] },
      ]),
    ).toEqual(["release/*"]);
    expect(configuredProtectedPatterns([])).toEqual([]);
  });
});

describe("workingRepoGit", () => {
  let root: string;
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "delivery-branches-"));
    const remote = path.join(root, "remote.git");
    const clone = path.join(root, "clone");
    git(root, "init", "--bare", "-b", "trunk", remote);
    git(root, "clone", remote, clone);
    git(clone, "config", "user.email", "t@example.com");
    git(clone, "config", "user.name", "T");
    git(clone, "commit", "--allow-empty", "-m", "first");
    git(clone, "push", "origin", "trunk");
    git(clone, "remote", "set-head", "origin", "trunk");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("reads the default branch from origin/HEAD and the current branch", async () => {
    const repo = workingRepoGit(path.join(root, "clone"));
    expect(await repo.defaultBranch()).toBe("trunk");
    expect(await repo.currentBranch()).toBe("trunk");
  });

  test("names local commits that are not on the remote", async () => {
    const clone = path.join(root, "clone");
    git(clone, "commit", "--allow-empty", "-m", "local only");
    const repo = workingRepoGit(clone);
    const unpushed = await repo.unpushedCommits();
    expect(unpushed).toHaveLength(1);
    expect(unpushed[0]).toContain("local only");
  });

  test("reports whether a branch exists locally or on the remote", async () => {
    const clone = path.join(root, "clone");
    git(clone, "branch", "change/x");
    const repo = workingRepoGit(clone);
    expect(await repo.branchExists("change/x")).toBe(true);
    expect(await repo.branchExists("trunk")).toBe(true);
    expect(await repo.branchExists("change/y")).toBe(false);
  });

  test("without origin/HEAD an existing origin/master is the default branch", async () => {
    const remote = path.join(root, "legacy.git");
    const clone = path.join(root, "legacy");
    git(root, "init", "--bare", "-b", "master", remote);
    git(root, "init", "-b", "master", clone);
    git(clone, "config", "user.email", "t@example.com");
    git(clone, "config", "user.name", "T");
    git(clone, "commit", "--allow-empty", "-m", "first");
    git(clone, "remote", "add", "origin", remote);
    git(clone, "push", "origin", "master");
    git(clone, "fetch", "origin");
    expect(await workingRepoGit(clone).defaultBranch()).toBe("master");
  });

  test("a detached HEAD has no current branch", async () => {
    const clone = path.join(root, "clone");
    git(clone, "checkout", "--detach");
    expect(await workingRepoGit(clone).currentBranch()).toBeNull();
  });
});
