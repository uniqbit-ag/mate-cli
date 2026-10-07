import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CompanionGitSync, CompanionGitSyncError, describeGitFailure } from "./companion-git-sync";
import { companionGitDeps } from "../../runtime/companion-git";
import { makeSshStub, stubSshUrl } from "../../../../../test/ssh-stub";

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
  git(companion, "config", "core.excludesFile", "/dev/null");
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
  git(upstream, "config", "core.excludesFile", "/dev/null");

  return { root, companion, upstream };
}

const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

/** A `git` on PATH that logs `<GIT_TERMINAL_PROMPT>\t<argv>` per call, then runs the real one. */
async function recordingGit(root: string): Promise<{
  env: Record<string, string | undefined>;
  calls: () => Promise<Array<{ prompt: string; args: string }>>;
}> {
  const bin = path.join(root, "recording-bin");
  const log = path.join(root, "git-calls.log");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(
    path.join(bin, "git"),
    `#!/bin/sh\nprintf '%s\\t%s\\n' "\${GIT_TERMINAL_PROMPT-unset}" "$*" >> '${log}'\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  return {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    calls: async () =>
      (await fs.readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [prompt, args] = line.split("\t");
          return { prompt: prompt!, args: args ?? "" };
        }),
  };
}

const originalIsTerminal = companionGitDeps.isTerminal;

beforeEach(() => {
  companionGitDeps.isTerminal = () => false;
});

afterEach(async () => {
  companionGitDeps.isTerminal = originalIsTerminal;
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("describeGitFailure", () => {
  test("strips carriage-return progress-meter noise and keeps diagnostic text", () => {
    const stderr =
      "Updating files:  76% (11340/14790)\rUpdating files: 100% (14790/14790), done.\nfatal: could not write file";
    expect(describeGitFailure({ status: 1, stdout: "", stderr })).toBe(
      "fatal: could not write file",
    );
  });

  test("keeps real error lines untouched", () => {
    const stderr =
      "error: Your local changes to the following files would be overwritten by merge:\n\tnotes.md";
    expect(describeGitFailure({ status: 1, stdout: "", stderr })).toBe(stderr);
  });

  test("falls back when output is only progress noise", () => {
    const stderr =
      "Updating files:   3% (12/400)\rUpdating files: 100% (400/400), done.\rChecking out files:  50% (2/4)";
    expect(describeGitFailure({ status: 1, stdout: "", stderr })).toBe("unknown Git error");
  });

  test("falls back to sanitized stdout when stderr is empty", () => {
    expect(
      describeGitFailure({
        status: 1,
        stdout: "merge: unrelated - not something we can merge",
        stderr: "",
      }),
    ).toBe("merge: unrelated - not something we can merge");
  });
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

  test("merges with --no-stat --no-progress and reports changed via HEAD movement", async () => {
    const { root, companion, upstream } = await makeRepository();
    await fs.writeFile(path.join(upstream, "remote.md"), "remote\n");
    git(upstream, "add", "remote.md");
    git(upstream, "commit", "-qm", "remote");
    git(upstream, "push", "-q");

    const recording = await recordingGit(root);

    const first = await new CompanionGitSync({ env: recording.env }).sync(companion);
    expect((await recording.calls()).map(({ args }) => args)).toContain(
      "merge origin/main --no-stat --no-progress --no-edit",
    );
    expect(first.changed).toBe(true);

    const second = await new CompanionGitSync().sync(companion);
    expect(second.changed).toBe(false);
  });

  test("keeps every command non-prompting by default", async () => {
    const { root, companion } = await makeRepository();
    const recording = await recordingGit(root);

    await new CompanionGitSync({ env: recording.env }).sync(companion);

    const calls = await recording.calls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(({ prompt }) => prompt === "0")).toBe(true);
  });

  test("lets only the fetch prompt in an interactive launch at a terminal", async () => {
    const { root, companion } = await makeRepository();
    const recording = await recordingGit(root);
    companionGitDeps.isTerminal = () => true;

    await new CompanionGitSync({ env: recording.env }).sync(companion, undefined, true);

    const calls = await recording.calls();
    expect(calls.find(({ args }) => args.startsWith("fetch "))?.prompt).toBe("unset");
    expect(
      calls.filter(({ args }) => !args.startsWith("fetch ")).every(({ prompt }) => prompt === "0"),
    ).toBe(true);
  });

  test("formats non-TTY authentication failures with non-interactive recovery guidance", async () => {
    const { root, companion } = await makeRepository();
    git(companion, "remote", "set-url", "origin", stubSshUrl(path.join(root, "remote.git")));
    const stub = makeSshStub(root);

    await expect(
      new CompanionGitSync({ env: stub.env("passphrase") }).sync(companion),
    ).rejects.toThrow(
      /Permission denied \(publickey\)[\s\S]*non-interactive Git credential helper or SSH agent[\s\S]*retry from a terminal[\s\S]*--no-git/,
    );
    expect(stub.calls()[0]).toContain("BatchMode=yes");
  });

  test("points an interactive failure at the diagnostics Git printed", async () => {
    const { root, companion } = await makeRepository();
    git(companion, "remote", "set-url", "origin", stubSshUrl(path.join(root, "remote.git")));
    const stub = makeSshStub(root);
    companionGitDeps.isTerminal = () => true;

    await expect(
      new CompanionGitSync({ env: stub.env("refused") }).sync(companion, undefined, true),
    ).rejects.toThrow(/review the Git or SSH diagnostics above[\s\S]*--no-git/);
    expect(stub.calls()[0]).not.toContain("BatchMode=yes");
  });

  test("keeps generic fetch failures on the existing recovery path", async () => {
    const { root, companion } = await makeRepository();
    git(companion, "remote", "set-url", "origin", path.join(root, "gone.git"));

    await expect(new CompanionGitSync().sync(companion)).rejects.toThrow(
      /Check the remote and network[\s\S]*--no-git/,
    );
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

  test("discloses the preflight stash when sync fails after stashing", async () => {
    const { companion, upstream } = await makeRepository();
    await fs.writeFile(path.join(companion, "notes.md"), "local dirty\n");
    await fs.writeFile(path.join(upstream, "notes.md"), "remote\n");
    git(upstream, "add", "notes.md");
    git(upstream, "commit", "-qm", "remote notes");
    git(upstream, "push", "-q");

    await expect(new CompanionGitSync().sync(companion)).rejects.toMatchObject({
      name: "CompanionGitSyncError",
      stashRef: expect.stringMatching(/^[0-9a-f]{40}$/),
      message: expect.stringContaining("git stash apply"),
    });
  });

  test("does not mention a stash when failing before one exists", async () => {
    const { companion } = await makeRepository();
    git(companion, "remote", "set-url", "origin", path.join(companion, "missing.git"));

    const rejection = new CompanionGitSync().sync(companion);
    await expect(rejection).rejects.toMatchObject({
      name: "CompanionGitSyncError",
      stashRef: undefined,
    });
    await rejection.catch((error: CompanionGitSyncError) => {
      expect(error.message).not.toContain("git stash apply");
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
