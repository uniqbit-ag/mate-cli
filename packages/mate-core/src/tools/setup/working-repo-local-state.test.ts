import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  ensureWorkingRepoLocalExcludes,
  removeWorkingRepoLocalExcludes,
} from "./working-repo-local-state";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function makeRepo(prefix: string): Promise<string> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(repoPath);
  await execFileAsync("git", ["init", "-q", repoPath]);
  return repoPath;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("working repository local excludes", () => {
  test("reconciles one root-anchored managed block and migrates legacy entries", async () => {
    const repoPath = await makeRepo("mate-working-excludes-");
    const excludePath = path.join(repoPath, ".git", "info", "exclude");
    await fs.writeFile(
      excludePath,
      ["# user rule", "*.local", ".mate/", ".claude/settings.local.json", ""].join("\n"),
      "utf8",
    );

    await ensureWorkingRepoLocalExcludes(repoPath);
    const first = await fs.readFile(excludePath, "utf8");
    await ensureWorkingRepoLocalExcludes(repoPath);
    const second = await fs.readFile(excludePath, "utf8");

    expect(second).toBe(first);
    expect(first).toContain("# user rule\n*.local\n");
    expect(first).not.toContain(".claude/settings.local.json");
    expect(first.match(/# mate managed: start/g)).toHaveLength(1);
    expect(first.match(/# mate managed: end/g)).toHaveLength(1);
    for (const entry of ["/.mate/", "/.claude/", "/.opencode/", "/.agents/"]) {
      expect(first.split("\n").filter((line) => line === entry)).toHaveLength(1);
    }
  });

  test("preserves equivalent user rules outside the managed block", async () => {
    const repoPath = await makeRepo("mate-working-user-excludes-");
    const excludePath = path.join(repoPath, ".git", "info", "exclude");
    await fs.writeFile(excludePath, "/.claude/\n", "utf8");

    await ensureWorkingRepoLocalExcludes(repoPath);
    await removeWorkingRepoLocalExcludes(repoPath);

    expect(await fs.readFile(excludePath, "utf8")).toBe("/.claude/\n");
  });

  test("writes and removes the managed block through a worktree-style git file", async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "mate-working-worktree-"));
    tempRoots.push(repoPath);
    const gitDir = path.join(repoPath, ".worktrees", "repo-git");
    await fs.mkdir(path.join(gitDir, "info"), { recursive: true });
    await fs.writeFile(path.join(repoPath, ".git"), "gitdir: .worktrees/repo-git\n", "utf8");

    await ensureWorkingRepoLocalExcludes(repoPath);
    const excludePath = path.join(gitDir, "info", "exclude");
    expect(await fs.readFile(excludePath, "utf8")).toContain("/.agents/");

    await removeWorkingRepoLocalExcludes(repoPath);
    expect(await fs.readFile(excludePath, "utf8")).toBe("");
  });

  test("root patterns ignore untracked root state without hiding nested or tracked files", async () => {
    const repoPath = await makeRepo("mate-working-root-patterns-");
    await ensureWorkingRepoLocalExcludes(repoPath);
    await fs.mkdir(path.join(repoPath, ".claude"), { recursive: true });
    await fs.writeFile(path.join(repoPath, ".claude", "tracked.json"), "{}\n", "utf8");
    await execFileAsync("git", ["-C", repoPath, "add", "-f", ".claude/tracked.json"]);
    await fs.writeFile(path.join(repoPath, ".claude", "local.json"), "{}\n", "utf8");
    await fs.mkdir(path.join(repoPath, "fixtures", ".claude"), { recursive: true });
    await fs.writeFile(path.join(repoPath, "fixtures", ".claude", "visible.json"), "{}\n", "utf8");

    const tracked = await execFileAsync("git", [
      "-C",
      repoPath,
      "ls-files",
      ".claude/tracked.json",
    ]);
    const ignored = await execFileAsync("git", [
      "-C",
      repoPath,
      "check-ignore",
      ".claude/local.json",
    ]);
    const nested = await execFileAsync("git", [
      "-C",
      repoPath,
      "ls-files",
      "--others",
      "--exclude-standard",
      "fixtures/.claude/visible.json",
    ]);

    expect(tracked.stdout.trim()).toBe(".claude/tracked.json");
    expect(ignored.stdout.trim()).toBe(".claude/local.json");
    expect(nested.stdout.trim()).toBe("fixtures/.claude/visible.json");
  });
});
