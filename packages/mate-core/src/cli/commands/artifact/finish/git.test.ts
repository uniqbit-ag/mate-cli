/** @test-requires sockets */

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { makeSshStub, stubSshUrl } from "../../../../../../../test/ssh-stub";
import { defaultGitOps, RemoteFetchError } from "./git";

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
  git(cwd, ["config", "core.excludesFile", "/dev/null"]);
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

  test("classifies new and modified working-tree paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);
    const modifiedPath = path.join(root, "modified.txt");
    await fs.writeFile(modifiedPath, "before\n", "utf8");
    git(root, ["init", "-q"]);
    configureGit(root);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "initial"]);
    await fs.writeFile(modifiedPath, "after\n", "utf8");
    await fs.writeFile(path.join(root, "new.txt"), "new\n", "utf8");

    await expect(defaultGitOps(root).changedPathKinds?.()).resolves.toEqual({
      "modified.txt": "modified",
      "new.txt": "new",
    });
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

  test("commit keeps a cached removal deleted although its file stays on disk", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);
    const copy = path.join(root, ".claude", "skills", "mate-acme", "SKILL.md");
    await fs.mkdir(path.dirname(copy), { recursive: true });
    await fs.writeFile(copy, "acme\n", "utf8");
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");
    await fs.writeFile(path.join(root, "unrelated.txt"), "before\n", "utf8");
    git(root, ["init", "-q"]);
    configureGit(root);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "initial"]);

    await fs.writeFile(path.join(root, ".gitignore"), ".claude/skills/mate-acme/\n", "utf8");
    await fs.writeFile(path.join(root, "unrelated.txt"), "unrelated\n", "utf8");
    git(root, ["add", "unrelated.txt"]);
    git(root, ["rm", "--cached", "-q", ".claude/skills/mate-acme/SKILL.md"]);

    const ops = defaultGitOps(root);
    const removed = [".claude/skills/mate-acme/SKILL.md"];
    const written = [...removed, ".gitignore"];
    await ops.add(written);
    // `.gitignore` is not re-added: its working-tree content is still committed.
    await fs.writeFile(path.join(root, ".gitignore"), ".claude/skills/mate-acme/\nacme/\n", "utf8");
    await ops.commit("untrack", written, { removed });
    expect(gitOutput(root, ["show", "HEAD:.gitignore"])).toBe(".claude/skills/mate-acme/\nacme/");

    expect(gitOutput(root, ["show", "--format=", "--name-status", "HEAD"]).split("\n")).toEqual([
      "D\t.claude/skills/mate-acme/SKILL.md",
      "M\t.gitignore",
    ]);
    expect(gitOutput(root, ["diff", "--cached", "--name-only"])).toBe("unrelated.txt");
    expect(gitOutput(root, ["status", "--porcelain"])).toBe("M  unrelated.txt");
    await expect(fs.readFile(copy, "utf8")).resolves.toBe("acme\n");
  });

  test("commit with removals refuses an index with unresolved conflicts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);
    const copy = ".claude/skills/mate-acme/SKILL.md";
    await fs.mkdir(path.join(root, ".claude", "skills", "mate-acme"), { recursive: true });
    await fs.writeFile(path.join(root, copy), "acme\n", "utf8");
    await fs.writeFile(path.join(root, "acme.txt"), "base\n", "utf8");
    git(root, ["init", "-q", "-b", "main"]);
    configureGit(root);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "initial"]);
    git(root, ["switch", "-qc", "side"]);
    await fs.writeFile(path.join(root, "acme.txt"), "side\n", "utf8");
    git(root, ["commit", "-qam", "side"]);
    git(root, ["switch", "-q", "main"]);
    await fs.writeFile(path.join(root, "acme.txt"), "main\n", "utf8");
    git(root, ["commit", "-qam", "main"]);
    spawnSync("git", ["merge", "-q", "side"], { cwd: root });
    git(root, ["rm", "--cached", "-q", copy]);

    const ops = defaultGitOps(root);
    await expect(ops.commit("untrack", [copy, "acme.txt"], { removed: [copy] })).rejects.toThrow(
      "unresolved conflicts",
    );
    expect(gitOutput(root, ["log", "-1", "--format=%s"])).toBe("main");
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

  test("reports the checked-out branch and null in a detached HEAD", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);
    git(root, ["init", "-q", "-b", "trunk"]);
    configureGit(root);
    await fs.writeFile(path.join(root, "seed.txt"), "seed\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "initial"]);

    const ops = defaultGitOps(root);
    await expect(ops.currentBranch()).resolves.toBe("trunk");

    git(root, ["checkout", "-q", "--detach", "HEAD"]);

    await expect(defaultGitOps(root).currentBranch()).resolves.toBeNull();
  });

  test("default branch prefers the configured remote HEAD", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const local = path.join(root, "local");
    git(root, ["init", "--bare", "-q", "-b", "release", remote]);
    git(root, ["clone", "-q", remote, seed]);
    configureGit(seed);
    await fs.writeFile(path.join(seed, "seed.txt"), "seed\n", "utf8");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-qm", "initial"]);
    git(seed, ["push", "-qu", "origin", "HEAD:release"]);
    git(root, ["clone", "-q", remote, local]);
    configureGit(local);
    git(local, ["config", "init.defaultBranch", "ignored"]);
    git(local, ["remote", "set-head", "origin", "release"]);

    await expect(defaultGitOps(local).defaultBranch()).resolves.toBe("release");
  });

  test("default branch falls back to init.defaultBranch, then main", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-git-"));
    tempRoots.push(root);
    git(root, ["init", "-q"]);
    configureGit(root);

    await expect(defaultGitOps(root).defaultBranch()).resolves.toBe("main");

    git(root, ["config", "init.defaultBranch", "trunk"]);

    await expect(defaultGitOps(root).defaultBranch()).resolves.toBe("trunk");
  });
});

describe("publication credentials", () => {
  async function publishable(): Promise<{ root: string; remote: string; local: string }> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mate-finish-auth-")));
    tempRoots.push(root);
    const remote = path.join(root, "remote.git");
    const local = path.join(root, "local");
    git(root, ["init", "--bare", "-q", "-b", "main", remote]);
    git(root, ["clone", "-q", remote, local]);
    configureGit(local);
    git(local, ["checkout", "-q", "-b", "main"]);
    await fs.writeFile(path.join(local, "spec.md"), "published\n", "utf8");
    git(local, ["add", "."]);
    git(local, ["commit", "-qm", "publish"]);
    git(local, ["push", "-qu", "origin", "main"]);
    await fs.writeFile(path.join(local, "spec.md"), "published again\n", "utf8");
    git(local, ["commit", "-qam", "publish again"]);
    git(local, ["tag", "-a", "acme-v1", "-m", "Publish acme"]);
    return { root, remote, local };
  }

  const noWait = async () => {};

  test("an SSH rejection is retried, then reported as transient with the commit and tag kept", async () => {
    const { root, remote, local } = await publishable();
    git(local, ["remote", "set-url", "origin", stubSshUrl(remote)]);
    const stub = makeSshStub(root);
    const head = gitOutput(local, ["rev-parse", "HEAD"]);
    const waits: number[] = [];

    const started = Date.now();
    const push = await defaultGitOps(local, undefined, {
      env: stub.env("passphrase"),
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).push();

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(push.ok).toBe(false);
    expect(push.transient).toBe(true);
    expect(push.error).not.toContain("ssh-add");
    expect(waits).toEqual([1_000, 3_000]);
    expect(stub.calls()).toHaveLength(3);
    expect(stub.calls().every((call) => call.includes("BatchMode=yes"))).toBe(true);
    expect(gitOutput(local, ["rev-parse", "HEAD"])).toBe(head);
    expect(gitOutput(local, ["tag", "--list", "acme-v1"])).toBe("acme-v1");

    const rerun = await defaultGitOps(local, undefined, { env: stub.env("ok") }).push();

    expect(rerun.ok).toBe(true);
    expect(gitOutput(remote, ["rev-parse", "main"])).toBe(head);
    expect(gitOutput(remote, ["tag", "--list", "acme-v1"])).toBe("acme-v1");
  });

  test("a rejection that clears on retry publishes", async () => {
    const { root, remote, local } = await publishable();
    git(local, ["remote", "set-url", "origin", stubSshUrl(remote)]);
    const stub = makeSshStub(root);
    const ops = defaultGitOps(local, undefined, { env: stub.env("flaky"), sleep: noWait });

    await ops.fetch();
    const push = await ops.push();

    expect(push.ok).toBe(true);
    expect(stub.calls().length).toBeGreaterThanOrEqual(3);
    expect(gitOutput(remote, ["tag", "--list", "acme-v1"])).toBe("acme-v1");
  });

  test("a non-fast-forward push is not retried", async () => {
    const { root, remote, local } = await publishable();
    const other = path.join(root, "other");
    git(root, ["clone", "-q", remote, other]);
    configureGit(other);
    await fs.writeFile(path.join(other, "spec.md"), "elsewhere\n", "utf8");
    git(other, ["commit", "-qam", "elsewhere"]);
    git(other, ["push", "-q", "origin", "main"]);
    git(local, ["remote", "set-url", "origin", stubSshUrl(remote)]);
    const stub = makeSshStub(root);
    let waits = 0;

    const push = await defaultGitOps(local, undefined, {
      env: stub.env("ok"),
      sleep: async () => {
        waits += 1;
      },
    }).push();

    expect(push.ok).toBe(false);
    expect(push.transient).toBe(false);
    expect(waits).toBe(0);
  });

  test("an HTTPS credential failure is transient and never prompts", async () => {
    const { root, local } = await publishable();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="acme"' },
        }),
    });
    try {
      git(local, ["remote", "set-url", "origin", `http://127.0.0.1:${server.port}/acme.git`]);
      /** An editor's askpass helper would wait for input; publication must not call it. */
      const askPass = path.join(root, "askpass");
      await fs.writeFile(askPass, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
      const env = makeSshStub(root).env("refused", {
        GIT_ASKPASS: askPass,
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      });
      const ops = defaultGitOps(local, undefined, { env, sleep: noWait });

      const push = await ops.push();

      expect(push.ok).toBe(false);
      expect(push.transient).toBe(true);
      expect(push.error).not.toContain("credential helper");
      const fetchError = await ops.fetch().catch((err: unknown) => err);
      expect(fetchError).toBeInstanceOf(RemoteFetchError);
      expect((fetchError as RemoteFetchError).transient).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
