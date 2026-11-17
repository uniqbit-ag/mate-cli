import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { mergeGit, spawnProcess, type SpawnProcess } from "./merge-git";
import { localMergeEvidence } from "./refresh";

let root: string;
let remote: string;
let clone: string;
let other: string;

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "acme",
  GIT_AUTHOR_EMAIL: "acme@example.com",
  GIT_COMMITTER_NAME: "acme",
  GIT_COMMITTER_EMAIL: "acme@example.com",
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: ENV, stdio: "pipe" }).trim();

async function commit(cwd: string, file: string, content: string, message = file): Promise<string> {
  await fs.writeFile(path.join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** A clone with `main` and a two-commit `change/x` pushed to the bare remote. */
async function branchWithTwoCommits(): Promise<string> {
  git(clone, "switch", "-q", "-c", "change/x");
  await commit(clone, "a.txt", "a\n");
  const head = await commit(clone, "b.txt", "b\n");
  git(clone, "push", "-q", "origin", "change/x");
  git(clone, "switch", "-q", "main");
  return head;
}

/** Lands work on `main` from a second clone, the way a forge merge does. */
function landFromOther(...args: string[]): void {
  git(other, "fetch", "-q", "origin");
  git(other, "switch", "-q", "main");
  git(other, "reset", "-q", "--hard", "origin/main");
  git(other, ...args);
  git(other, "push", "-q", "origin", "main");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "merge-git-"));
  remote = path.join(root, "remote.git");
  clone = path.join(root, "clone");
  other = path.join(root, "other");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", remote, clone);
  git(clone, "switch", "-q", "-c", "main");
  await commit(clone, "base.txt", "base\n");
  git(clone, "push", "-q", "origin", "main");
  git(root, "clone", "-q", remote, other);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("mergeGit", () => {
  test("a merge commit and a fast-forward reach the default branch", async () => {
    const head = await branchWithTwoCommits();
    const repo = mergeGit(clone, { env: ENV });
    expect(await repo.tip("change/x")).toBe(head);
    expect(await repo.isAncestor(head, "main")).toBe(false);

    landFromOther("merge", "-q", "--no-ff", "-m", "Merge change/x", "origin/change/x");
    git(clone, "fetch", "-q", "origin");
    expect(await repo.isAncestor(head, "main")).toBe(true);
    expect(await repo.onFirstParent(head, "main")).toBe(false);
  });

  test("a fast-forward and a branch without own commits lie on the default branch's line", async () => {
    const repo = mergeGit(clone, { env: ENV });
    git(clone, "switch", "-q", "-c", "change/empty");
    const empty = git(clone, "rev-parse", "HEAD");
    expect(await repo.isAncestor(empty, "main")).toBe(true);
    expect(await repo.onFirstParent(empty, "main")).toBe(true);

    git(clone, "switch", "-q", "main");
    const head = await branchWithTwoCommits();
    landFromOther("merge", "-q", "--ff-only", "origin/change/x");
    landFromOther("commit", "-q", "--allow-empty", "-m", "later");
    git(clone, "fetch", "-q", "origin");
    expect(await repo.isAncestor(head, "main")).toBe(true);
    expect(await repo.onFirstParent(head, "main")).toBe(true);
  });

  test("a first-parent check Git could not run is unknown, not a merge commit", async () => {
    git(clone, "switch", "-q", "-c", "change/empty");
    const empty = git(clone, "rev-parse", "HEAD");
    const spawn: SpawnProcess = async (command, args, options) =>
      args[0] === "rev-list"
        ? { code: -1, stdout: "", stderr: "", timedOut: true }
        : spawnProcess(command, args, options);
    expect(await mergeGit(clone, { env: ENV, spawn }).onFirstParent(empty, "main")).toBeNull();
  });

  test("a squash merge matches the whole branch diff", async () => {
    const head = await branchWithTwoCommits();
    landFromOther("merge", "-q", "--squash", "origin/change/x");
    git(other, "commit", "-q", "-m", "Squash change/x");
    git(other, "push", "-q", "origin", "main");
    git(clone, "fetch", "-q", "origin");
    const repo = mergeGit(clone, { env: ENV });
    expect(await repo.isAncestor(head, "main")).toBe(false);
    expect(await repo.patchMatch(head, "main")).toEqual({
      commit: git(clone, "rev-parse", "origin/main"),
      style: "squash",
    });
  });

  test("a rebase merge matches every branch commit", async () => {
    const head = await branchWithTwoCommits();
    // Move main first, so the picked commits get new parents and new ids.
    landFromOther("commit", "-q", "--allow-empty", "-m", "moved");
    landFromOther("cherry-pick", "origin/main~1..origin/change/x");
    git(clone, "fetch", "-q", "origin");
    const repo = mergeGit(clone, { env: ENV });
    expect(await repo.isAncestor(head, "main")).toBe(false);
    expect(await repo.patchMatch(head, "main")).toEqual({
      commit: git(clone, "rev-parse", "origin/main"),
      style: "rebase",
    });
  });

  test("an unrelated branch matches nothing", async () => {
    const head = await branchWithTwoCommits();
    landFromOther("commit", "-q", "--allow-empty", "-m", "unrelated");
    await commit(other, "z.txt", "z\n");
    git(other, "push", "-q", "origin", "main");
    git(clone, "fetch", "-q", "origin");
    expect(await mergeGit(clone, { env: ENV }).patchMatch(head, "main")).toBeNull();
  });

  test("a deleted branch is answered through its recorded head", async () => {
    const head = await branchWithTwoCommits();
    landFromOther("merge", "-q", "--no-ff", "-m", "Merge", "origin/change/x");
    git(clone, "push", "-q", "origin", "--delete", "change/x");
    git(clone, "fetch", "-q", "--prune", "origin");
    const repo = mergeGit(clone, { env: ENV });
    expect(await repo.tip("change/x")).toBe(head);
    git(clone, "branch", "-q", "-D", "change/x");
    expect(await repo.tip("change/x")).toBeNull();
    expect(await repo.hasCommit(head)).toBe(true);
    expect(await repo.isAncestor(head, "main")).toBe(true);
  });

  test("a partial clone skips patch matching", async () => {
    const head = await branchWithTwoCommits();
    git(clone, "config", "remote.origin.promisor", "true");
    landFromOther("merge", "-q", "--squash", "origin/change/x");
    git(other, "commit", "-q", "-m", "Squash");
    git(other, "push", "-q", "origin", "main");
    git(clone, "fetch", "-q", "origin");
    expect(await mergeGit(clone, { env: ENV }).patchMatch(head, "main")).toBeNull();
  });

  test("more upstream commits than the limit are not compared", async () => {
    const head = await branchWithTwoCommits();
    const spawn: SpawnProcess = async (command, args, options) =>
      args[0] === "rev-list"
        ? { code: 0, stdout: "501\n", stderr: "" }
        : spawnProcess(command, args, options);
    expect(await mergeGit(clone, { env: ENV, spawn }).patchMatch(head, "main")).toBeNull();
  });

  test("lastFetchedAt reads the time of the last fetch", async () => {
    const repo = mergeGit(clone, { env: ENV });
    expect(await repo.lastFetchedAt()).toBeNull();
    git(clone, "fetch", "-q", "origin");
    expect(Date.parse((await repo.lastFetchedAt()) ?? "")).toBeGreaterThan(Date.now() - 60_000);
  });

  test("local queries never allow lazy fetching or prompts", async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const spawn: SpawnProcess = async (command, args, options) => {
      seen.push(options.env);
      return spawnProcess(command, args, options);
    };
    await mergeGit(clone, { env: { ...ENV, GIT_ASKPASS: "/acme/askpass" }, spawn }).tip("main");
    expect(seen[0]).toMatchObject({ GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" });
    expect(seen[0].GIT_ASKPASS).toBeUndefined();
  });
});

describe("mergeGit.fetch", () => {
  test("updates origin refs for the default and delivery branches", async () => {
    await branchWithTwoCommits();
    landFromOther("commit", "-q", "--allow-empty", "-m", "moved");
    const result = await mergeGit(clone, { env: ENV }).fetch("main", "change/x");
    expect(result).toEqual({ ok: true });
    expect(git(clone, "rev-parse", "origin/main")).toBe(git(other, "rev-parse", "HEAD"));
  });

  test("a delivery branch missing on origin still fetches the default branch", async () => {
    landFromOther("commit", "-q", "--allow-empty", "-m", "moved");
    expect(await mergeGit(clone, { env: ENV }).fetch("main", "change/gone")).toEqual({
      ok: true,
      branchDeleted: true,
    });
    expect(git(clone, "rev-parse", "origin/main")).toBe(git(other, "rev-parse", "HEAD"));
  });

  test("an invalid branch name is never fetched", async () => {
    const seen: Array<readonly string[]> = [];
    const spawn: SpawnProcess = async (command, args, options) => {
      seen.push(args);
      return spawnProcess(command, args, options);
    };
    const result = await mergeGit(clone, { env: ENV, spawn }).fetch("main", "x:refs/heads/main");
    expect(result).toEqual({
      ok: false,
      message: "git fetch failed: invalid branch name: x:refs/heads/main",
    });
    expect(seen.filter((args) => args[0] === "fetch")).toHaveLength(1);
  });

  test("an unreachable remote is a failure, never a throw", async () => {
    git(clone, "remote", "set-url", "origin", path.join(root, "missing.git"));
    const result = await mergeGit(clone, { env: ENV }).fetch("main", "change/x");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("git fetch failed");
  });

  test("fetch never prompts and only narrows SSH when the user has no SSH command", async () => {
    const seen: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const spawn: SpawnProcess = async (command, args, options) => {
      seen.push({ args, env: options.env });
      return command === "git" && args[0] === "fetch"
        ? { code: 0, stdout: "", stderr: "" }
        : spawnProcess(command, args, options);
    };
    await mergeGit(clone, { env: { ...ENV, SSH_ASKPASS: "/acme/askpass" }, spawn }).fetch(
      "main",
      "change/x",
    );
    const fetches = seen.filter((call) => call.args[0] === "fetch");
    expect(fetches.map((call) => call.args.at(-1))).toEqual([
      "+refs/heads/main:refs/remotes/origin/main",
      "+refs/heads/change/x:refs/remotes/origin/change/x",
    ]);
    expect(fetches[0].args).toContain("--no-tags");
    expect(fetches[0].env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    });
    expect(fetches[0].env.SSH_ASKPASS).toBeUndefined();
    const config = Object.fromEntries(
      Array.from({ length: Number(fetches[0].env.GIT_CONFIG_COUNT) }, (_, index) => [
        fetches[0].env[`GIT_CONFIG_KEY_${index}`],
        fetches[0].env[`GIT_CONFIG_VALUE_${index}`],
      ]),
    );
    expect(config).toMatchObject({ "maintenance.auto": "false", "gc.auto": "0" });

    seen.length = 0;
    await mergeGit(clone, { env: { ...ENV, GIT_SSH_COMMAND: "ssh -i /acme/key" }, spawn }).fetch(
      "main",
      "main",
    );
    expect(seen.find((call) => call.args[0] === "fetch")?.env.GIT_SSH_COMMAND).toBe(
      "ssh -i /acme/key",
    );
  });
});

/** Squashes `origin/change/x` onto `main` from the second clone with `message`. */
function squashFromOther(message: string): string {
  landFromOther("merge", "-q", "--squash", "origin/change/x");
  git(other, "commit", "-q", "-m", message);
  git(other, "push", "-q", "origin", "main");
  return git(other, "rev-parse", "HEAD");
}

describe("mergeGit containment", () => {
  test("a squash after a review fix with an edited message contains the head", async () => {
    await branchWithTwoCommits();
    git(clone, "switch", "-q", "change/x");
    const head = await commit(clone, "a.txt", "a, reviewed\n", "review fix");
    git(clone, "push", "-q", "origin", "change/x");
    git(clone, "switch", "-q", "main");
    const squash = squashFromOther("Acme widget (#42)\n\nEdited by the merger.");
    git(clone, "fetch", "-q", "origin");
    const repo = mergeGit(clone, { env: ENV });
    expect(await repo.isAncestor(head, "main")).toBe(false);
    expect(await repo.contains(squash, head)).toBe(true);
    expect(await repo.firstContaining(head, "main")).toEqual({
      commit: squash,
      committedAt: new Date(git(clone, "show", "-s", "--format=%cI", squash)).toISOString(),
    });
  });

  test("a rebase merge is found at the commit that added the last branch commit", async () => {
    git(clone, "switch", "-q", "-c", "change/x");
    await commit(clone, "a.txt", "a\n");
    await commit(clone, "b.txt", "b\n");
    const head = await commit(clone, "c.txt", "c\n");
    git(clone, "push", "-q", "origin", "change/x");
    git(clone, "switch", "-q", "main");
    landFromOther("commit", "-q", "--allow-empty", "-m", "moved");
    landFromOther("cherry-pick", "origin/main~1..origin/change/x");
    git(clone, "fetch", "-q", "origin");
    const result = await mergeGit(clone, { env: ENV }).firstContaining(head, "main");
    expect(result).toMatchObject({ commit: git(clone, "rev-parse", "origin/main") });
  });

  test("a conflict resolved as merging the head would is contained", async () => {
    git(clone, "switch", "-q", "-c", "change/x");
    const head = await commit(clone, "base.txt", "branch\n");
    git(clone, "push", "-q", "origin", "change/x");
    git(clone, "switch", "-q", "main");
    landFromOther("commit", "-q", "--allow-empty", "-m", "unrelated");
    await commit(other, "base.txt", "main\n");
    git(other, "push", "-q", "origin", "main");
    // The squash resolves the conflict with the branch's version.
    await commit(other, "base.txt", "branch\n", "Squash change/x");
    git(other, "push", "-q", "origin", "main");
    git(clone, "fetch", "-q", "origin");
    const result = await mergeGit(clone, { env: ENV }).firstContaining(head, "main");
    expect(result).toMatchObject({ commit: git(clone, "rev-parse", "origin/main") });
  });

  test("a later rewrite of the same lines keeps the squash as merge commit", async () => {
    const head = await branchWithTwoCommits();
    const squash = squashFromOther("Squash change/x");
    await commit(other, "a.txt", "rewritten\n", "rewrite");
    git(other, "push", "-q", "origin", "main");
    git(clone, "fetch", "-q", "origin");
    const repo = mergeGit(clone, { env: ENV });
    expect(await repo.contains(git(clone, "rev-parse", "origin/main"), head)).toBe(false);
    expect(await repo.firstContaining(head, "main")).toMatchObject({ commit: squash });
  });

  test("unrelated later commits leave the squash, not the tip, as merge commit", async () => {
    const head = await branchWithTwoCommits();
    const squash = squashFromOther("Squash change/x");
    await commit(other, "z.txt", "z\n");
    git(other, "push", "-q", "origin", "main");
    git(clone, "fetch", "-q", "origin");
    expect(await mergeGit(clone, { env: ENV }).firstContaining(head, "main")).toMatchObject({
      commit: squash,
    });
  });

  test("a squash of an earlier head contains no later head", async () => {
    await branchWithTwoCommits();
    squashFromOther("Squash change/x");
    git(clone, "switch", "-q", "change/x");
    const head = await commit(clone, "b.txt", "b, reviewed\n", "late review fix");
    git(clone, "switch", "-q", "main");
    git(clone, "fetch", "-q", "origin");
    expect(await mergeGit(clone, { env: ENV }).firstContaining(head, "main")).toBe("none");
  });

  test("a branch that only merged main has no content of its own and cannot tell", async () => {
    git(clone, "switch", "-q", "-c", "change/x");
    landFromOther("commit", "-q", "--allow-empty", "-m", "moved");
    git(clone, "fetch", "-q", "origin");
    git(clone, "merge", "-q", "--no-ff", "-m", "Merge main", "origin/main");
    const head = git(clone, "rev-parse", "HEAD");
    git(clone, "push", "-q", "origin", "change/x");
    git(clone, "switch", "-q", "main");
    landFromOther("commit", "-q", "--allow-empty", "-m", "later");
    git(clone, "fetch", "-q", "origin");
    const repo = mergeGit(clone, { env: ENV });
    expect(await repo.isAncestor(head, "main")).toBe(false);
    expect(await repo.firstContaining(head, "main")).toBe("unknown");
  });

  test("more candidates than the bound without a hit cannot tell", async () => {
    const head = await branchWithTwoCommits();
    landFromOther("commit", "-q", "--allow-empty", "-m", "first");
    squashFromOther("Squash change/x");
    git(clone, "fetch", "-q", "origin");
    const repo = mergeGit(clone, { env: ENV, containmentLimit: 1 });
    expect(await repo.firstContaining(head, "main")).toBe("unknown");
  });

  test("a partial clone missing an object settles nothing and fetches nothing", async () => {
    git(remote, "config", "uploadpack.allowFilter", "true");
    git(clone, "switch", "-q", "-c", "change/x");
    const head = await commit(clone, "base.txt", "base\nbranch\n");
    git(clone, "push", "-q", "origin", "change/x");
    // A squash with a line of its own: telling it contains the head needs a content merge.
    landFromOther("switch", "-q", "main");
    const squash = await commit(other, "base.txt", "main\nbase\nbranch\n", "Squash with a fix");
    git(other, "push", "-q", "origin", "main");
    git(clone, "fetch", "-q", "origin");
    expect(await mergeGit(clone, { env: ENV }).firstContaining(head, "main")).toMatchObject({
      commit: squash,
    });
    const partial = path.join(root, "partial");
    git(root, "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${remote}`, partial);
    git(partial, "fetch", "-q", "origin", "+refs/heads/change/x:refs/remotes/origin/change/x");
    const missing = git(partial, "rev-parse", `${head}:base.txt`);
    const repo = mergeGit(partial, { env: ENV });
    expect(await repo.firstContaining(head, "main")).toBe("unknown");
    // Still missing: no lazy fetch reached the remote.
    expect(() =>
      execFileSync("git", ["cat-file", "-e", missing], {
        cwd: partial,
        env: { ...ENV, GIT_NO_LAZY_FETCH: "1" },
        stdio: "pipe",
      }),
    ).toThrow();
  });

  test("Git without merge-tree --write-tree reports no containment", async () => {
    const head = await branchWithTwoCommits();
    squashFromOther("Squash change/x");
    git(clone, "fetch", "-q", "origin");
    const spawn: SpawnProcess = async (command, args, options) =>
      args[0] === "version"
        ? { code: 0, stdout: "git version 2.37.1\n", stderr: "" }
        : spawnProcess(command, args, options);
    const repo = mergeGit(clone, { env: ENV, spawn });
    expect(await repo.supportsContainment()).toBe(false);
    expect(await repo.firstContaining(head, "main")).toBe("unknown");
    expect(await repo.contains(git(clone, "rev-parse", "origin/main"), head)).toBeNull();
    expect(await repo.patchMatch(head, "main")).toMatchObject({ style: "squash" });
  });
});

describe("mergeGit pull refs", () => {
  test("lists pull and merge request heads and fetches one without writing a ref", async () => {
    const head = await branchWithTwoCommits();
    git(remote, "update-ref", "refs/pull/42/head", head);
    git(remote, "update-ref", "refs/pull/42/merge", head);
    git(remote, "update-ref", "refs/merge-requests/7/head", head);
    const repo = mergeGit(clone, { env: ENV });
    expect((await repo.pullRefs())?.toSorted((a, b) => a.number - b.number)).toEqual([
      { number: 7, ref: "merge-requests", commit: head },
      { number: 42, ref: "pull", commit: head },
    ]);

    git(clone, "fetch", "-q", "origin");
    const before = git(clone, "for-each-ref", "--format=%(refname)");
    const fetchedAt = await repo.lastFetchedAt();
    expect(fetchedAt).not.toBeNull();
    expect(await repo.fetchPullHead(42, "pull")).toBe(head);
    expect(git(clone, "for-each-ref", "--format=%(refname)")).toBe(before);
    // `FETCH_HEAD` still tells when origin was last fetched.
    expect(await repo.lastFetchedAt()).toBe(fetchedAt);
    expect(await repo.fetchPullHead(99, "pull")).toBeNull();
  });

  test("a failed listing is null", async () => {
    git(clone, "remote", "set-url", "origin", path.join(root, "missing.git"));
    expect(await mergeGit(clone, { env: ENV }).pullRefs()).toBeNull();
  });
});

describe("mergeGit.dirtyWorktree", () => {
  const dirty = (branch: string) => mergeGit(clone, { env: ENV }).dirtyWorktree(branch);

  test("names the work tree whose branch holds modified tracked files", async () => {
    await branchWithTwoCommits();
    git(clone, "switch", "-q", "change/x");
    expect(await dirty("change/x")).toBeNull();

    await fs.writeFile(path.join(clone, "scratch.txt"), "untracked\n");
    expect(await dirty("change/x")).toBeNull();

    await fs.writeFile(path.join(clone, "a.txt"), "a, edited\n");
    expect(await fs.realpath((await dirty("change/x"))!)).toBe(await fs.realpath(clone));
  });

  test("a branch checked out nowhere has no work tree to look at", async () => {
    await branchWithTwoCommits();
    await fs.writeFile(path.join(clone, "base.txt"), "base, edited\n");

    expect(await dirty("change/x")).toBeNull();
  });

  test("a linked work tree of the checkout is found", async () => {
    await branchWithTwoCommits();
    const linked = path.join(root, "linked");
    git(clone, "worktree", "add", "-q", linked, "change/x");
    expect(await dirty("change/x")).toBeNull();

    await fs.writeFile(path.join(linked, "b.txt"), "b, edited\n");
    expect(await fs.realpath((await dirty("change/x"))!)).toBe(await fs.realpath(linked));
  });
});

describe("mergeGit.remoteTip", () => {
  test("answers the remote branch only", async () => {
    const pushed = await branchWithTwoCommits();
    git(clone, "switch", "-q", "-c", "change/local");
    const merges = mergeGit(clone, { env: ENV });

    expect(await merges.remoteTip("change/x")).toBe(pushed);
    expect(await merges.remoteTip("change/local")).toBeNull();
  });
});

describe("a head ahead of the remote branch", () => {
  const evidence = (recorded?: string) =>
    localMergeEvidence(mergeGit(clone, { env: ENV }), "main", "change/x", recorded);

  test("an earlier merge of the branch does not settle later unpushed commits", async () => {
    await branchWithTwoCommits();
    landFromOther("merge", "-q", "--no-ff", "-m", "Merge change/x", "origin/change/x");
    git(clone, "fetch", "-q", "origin");
    git(clone, "switch", "-q", "change/x");
    const unpushed = await commit(clone, "c.txt", "c\n");

    expect(await evidence()).toMatchObject({ head: unpushed, merged: false });
  });

  test("a second change on a squash-merged branch waits for its own commits", async () => {
    await branchWithTwoCommits();
    landFromOther("merge", "-q", "--squash", "origin/change/x");
    git(other, "commit", "-q", "-m", "Squash change/x");
    git(other, "push", "-q", "origin", "main");
    git(clone, "fetch", "-q", "origin");
    expect(await evidence()).toMatchObject({ merged: true });

    git(clone, "switch", "-q", "change/x");
    const unpushed = await commit(clone, "c.txt", "c\n");
    expect(await evidence()).toMatchObject({ head: unpushed, merged: false });
  });

  test("a recorded head ahead of the remote is checked without the local branch", async () => {
    const pushed = await branchWithTwoCommits();
    landFromOther("merge", "-q", "--no-ff", "-m", "Merge change/x", "origin/change/x");
    git(clone, "fetch", "-q", "origin");
    git(clone, "switch", "-q", "change/x");
    const recorded = await commit(clone, "c.txt", "c\n");
    git(clone, "switch", "-q", "main");
    git(clone, "branch", "-q", "-D", "change/x");

    expect(await evidence(recorded)).toMatchObject({ live: pushed, head: recorded, merged: false });
  });

  test("a review fix pushed after the head was recorded still settles", async () => {
    const recorded = await branchWithTwoCommits();
    git(clone, "switch", "-q", "change/x");
    const fixed = await commit(clone, "a.txt", "a, fixed\n", "review fix");
    git(clone, "push", "-q", "origin", "change/x");
    git(clone, "switch", "-q", "main");
    landFromOther("merge", "-q", "--squash", "origin/change/x");
    git(other, "commit", "-q", "-m", "Squash change/x");
    git(other, "push", "-q", "origin", "main");
    git(clone, "fetch", "-q", "origin");

    expect(await evidence(recorded)).toMatchObject({ head: fixed, merged: true });
  });

  test("a branch rewritten on the remote wins over the recorded head", async () => {
    const recorded = await branchWithTwoCommits();
    git(other, "fetch", "-q", "origin");
    git(other, "switch", "-q", "-c", "change/x", "origin/main");
    const rewritten = await commit(other, "a.txt", "a, rebased\n");
    git(other, "push", "-q", "--force", "origin", "change/x");
    git(clone, "fetch", "-q", "origin");
    git(clone, "branch", "-q", "-D", "change/x");

    expect(await evidence(recorded)).toMatchObject({ head: rewritten, merged: false });
  });
});
