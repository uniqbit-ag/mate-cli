import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export interface RebaseResult {
  ok: boolean;
  conflictedPaths: string[];
}

export interface PushResult {
  ok: boolean;
  error: string;
}

/**
 * Git operations the finish engine needs, injectable for deterministic tests. All
 * operations run against the companion working tree.
 */
export interface GitOps {
  /** Full SHA of the current HEAD (recorded pre-finish for rollback). */
  headRef(): Promise<string>;
  /** Paths with uncommitted changes (porcelain), for scope-aware guards. */
  changedPaths(): Promise<string[]>;
  /** Paths already present in the index. */
  stagedPaths(): Promise<string[]>;
  /** Stage the given pathspecs. */
  add(paths: string[]): Promise<void>;
  /** True when the index has staged changes, optionally limited to pathspecs. */
  hasStagedChanges(paths?: string[]): Promise<boolean>;
  /** Commit only the supplied pathspecs, leaving unrelated staged work untouched. */
  commit(message: string, paths?: string[]): Promise<void>;
  /** Restore only produced artifact paths to a recorded ref. */
  restorePaths(ref: string, paths: string[]): Promise<void>;
  hasUpstream(): Promise<boolean>;
  fetch(): Promise<void>;
  rebaseOntoUpstream(): Promise<RebaseResult>;
  tagExists(name: string): Promise<boolean>;
  tag(name: string, message: string): Promise<void>;
  /** Push the branch and any annotated tags (`--follow-tags`). */
  push(): Promise<PushResult>;
}

function gitRun(
  companionPath: string,
  args: string[],
): { status: number; out: string; err: string } {
  const {
    GIT_DIR: _gitDir,
    GIT_WORK_TREE: _gitWorkTree,
    GIT_COMMON_DIR: _gitCommonDir,
    GIT_INDEX_FILE: _gitIndexFile,
    ...gitEnv
  } = process.env;
  const result = spawnSync("git", args, {
    cwd: companionPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv,
  });
  return {
    status: result.status ?? 1,
    out: (result.stdout ?? "").trimEnd(),
    err: (result.stderr ?? "").trim(),
  };
}

function resolvedPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function assertSafeCompanionRoot(companionPath: string, workingRepoPath?: string): void {
  const companionRoot = resolvedPath(companionPath);
  const workingRoot = workingRepoPath ? resolvedPath(workingRepoPath) : undefined;

  if (workingRoot && companionRoot === workingRoot) {
    throw new Error(
      "mate: refusing finish Git operations because companion and working repo are identical",
    );
  }

  try {
    fs.statSync(path.join(companionRoot, ".git"));
  } catch {
    throw new Error(
      `mate: refusing finish Git operations because companion is not a Git root: ${companionRoot}`,
    );
  }
}

// `git status --porcelain` lines are `XY <path>`, or `XY <old> -> <new>` for renames.
function parsePorcelainPath(line: string): string {
  const body = line.slice(3);
  const arrow = body.indexOf(" -> ");
  return arrow === -1 ? body : body.slice(arrow + 4);
}

export function defaultGitOps(
  companionPath: string,
  workingRepoPath = process.env.MATE_REPO_PATH,
): GitOps {
  assertSafeCompanionRoot(companionPath, workingRepoPath);
  const exec = (args: string[]) => gitRun(companionPath, args);
  const execOrThrow = (args: string[]) => {
    const res = exec(args);
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.err || res.out}`);
    }
    return res;
  };
  return {
    async headRef() {
      return execOrThrow(["rev-parse", "HEAD"]).out;
    },
    async changedPaths() {
      const out = exec(["status", "--porcelain"]).out;
      if (out.length === 0) return [];
      return out.split("\n").map(parsePorcelainPath);
    },
    async stagedPaths() {
      const out = exec(["diff", "--cached", "--name-only"]).out;
      return out.length === 0 ? [] : out.split("\n");
    },
    async add(paths) {
      const applicable = paths.filter(
        (filePath) =>
          exec(["ls-files", "--cached", "--others", "--exclude-standard", "--", filePath]).out
            .length > 0,
      );
      if (applicable.length > 0) {
        execOrThrow(["add", "--", ...applicable]);
      }
    },
    async hasStagedChanges(paths) {
      // `diff --cached --quiet` exits 1 when there ARE staged changes.
      const pathspec = paths && paths.length > 0 ? ["--", ...paths] : [];
      return exec(["diff", "--cached", "--quiet", ...pathspec]).status !== 0;
    },
    async commit(message, paths) {
      // A produced path can be unknown to git entirely — e.g. an active change dir that
      // was never committed and has just been moved into the archive. `git commit` rejects
      // such pathspecs ("did not match any file(s) known to git"), so keep only paths that
      // exist in the index or in HEAD (staged deletions match HEAD, new files the index).
      const known = (paths ?? []).filter(
        (filePath) =>
          exec(["ls-files", "--cached", "--", filePath]).out.length > 0 ||
          exec(["ls-tree", "--name-only", "HEAD", "--", filePath]).out.length > 0,
      );
      const pathspec = known.length > 0 ? ["--", ...known] : [];
      if (paths && paths.length > 0 && known.length === 0) return;
      execOrThrow(["commit", "-m", message, ...pathspec]);
    },
    async restorePaths(ref, paths) {
      const tracked = paths.filter(
        (filePath) => exec(["ls-files", "--cached", "--", filePath]).out.length > 0,
      );
      if (tracked.length > 0) {
        execOrThrow(["restore", "--source", ref, "--staged", "--worktree", "--", ...tracked]);
      }

      // `git restore` does not remove newly-created untracked archive files.
      const untracked = paths.filter(
        (filePath) =>
          exec(["ls-files", "--others", "--exclude-standard", "--", filePath]).out.length > 0,
      );
      if (untracked.length > 0) {
        execOrThrow(["clean", "-fd", "--", ...untracked]);
      }
    },
    async hasUpstream() {
      return exec(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).status === 0;
    },
    async fetch() {
      execOrThrow(["fetch"]);
    },
    async rebaseOntoUpstream() {
      const res = exec(["rebase", "--autostash", "@{u}"]);
      const conflicts = exec(["diff", "--name-only", "--diff-filter=U"]);
      if (res.status === 0 && conflicts.out.length === 0) {
        return { ok: true, conflictedPaths: [] };
      }
      return {
        ok: false,
        conflictedPaths: conflicts.out.length > 0 ? conflicts.out.split("\n") : [],
      };
    },
    async tagExists(name) {
      return exec(["tag", "--list", name]).out.length > 0;
    },
    async tag(name, message) {
      execOrThrow(["tag", "-a", name, "-m", message]);
    },
    async push() {
      const res = exec(["push", "--follow-tags"]);
      return { ok: res.status === 0, error: res.err || res.out };
    },
  };
}
