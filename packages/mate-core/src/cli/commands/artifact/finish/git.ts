import fs from "node:fs";
import path from "node:path";

import {
  companionGit,
  isAuthenticationFailure,
  type NetworkGitResult,
} from "../../../../runtime/companion-git";

export interface RebaseResult {
  ok: boolean;
  conflictedPaths: string[];
}

export interface PushResult {
  ok: boolean;
  error: string;
}

export type WorkingTreeChange = "new" | "modified";

/**
 * Git operations the finish engine needs, injectable for deterministic tests. All
 * operations run against the companion working tree.
 */
export interface GitOps {
  /** Checked-out branch name, or null in a detached HEAD. */
  currentBranch(): Promise<string | null>;
  /** Branch publication is allowed on: remote HEAD, then `init.defaultBranch`, then `main`. */
  defaultBranch(): Promise<string>;
  /** Paths with uncommitted changes (porcelain), for scope-aware guards. */
  changedPaths(): Promise<string[]>;
  /** Git change kind by path, for consumers that need new versus modified metadata. */
  changedPathKinds?(): Promise<Record<string, WorkingTreeChange>>;
  /** Paths already present in the index. */
  stagedPaths(): Promise<string[]>;
  /** Stage the given pathspecs. */
  add(paths: string[]): Promise<void>;
  /** True when the index has staged changes, optionally limited to pathspecs. */
  hasStagedChanges(paths?: string[]): Promise<boolean>;
  /** Commit only the supplied pathspecs, leaving unrelated staged work untouched. */
  commit(message: string, paths?: string[]): Promise<void>;
  hasUpstream(): Promise<boolean>;
  fetch(): Promise<void>;
  rebaseOntoUpstream(): Promise<RebaseResult>;
  tagExists(name: string): Promise<boolean>;
  tag(name: string, message: string): Promise<void>;
  /** Push the branch and any annotated tags (`--follow-tags`). */
  push(): Promise<PushResult>;
}

export interface GitOpsOptions {
  /** Environment Git runs with. */
  env?: Record<string, string | undefined>;
}

/**
 * Publication never prompts, so a credential failure must say how to supply
 * credentials non-interactively; the retained commit and tag make a re-run safe.
 */
function remoteFailureDetail(result: NetworkGitResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || "unknown Git error";
  if (!isAuthenticationFailure(result)) return detail;
  const remedy =
    result.transport === "ssh"
      ? "load the SSH key into an agent (`ssh-add`)"
      : "configure a Git credential helper (`git config --global credential.helper <helper>`)";
  return `${detail}\nPublication does not prompt for credentials: ${remedy}, then re-run \`mate artifact publish\`.`;
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

function parsePorcelainKind(line: string): WorkingTreeChange {
  const status = line.slice(0, 2);
  return status.includes("?") || status.includes("A") ? "new" : "modified";
}

/** Read-only index queries, so they may run concurrently; input order is kept. */
async function filterPaths(
  paths: string[],
  keep: (filePath: string) => Promise<boolean>,
): Promise<string[]> {
  const kept = await Promise.all(paths.map(keep));
  return paths.filter((_, index) => kept[index]);
}

export function defaultGitOps(
  companionPath: string,
  workingRepoPath = process.env.MATE_REPO_PATH,
  options: GitOpsOptions = {},
): GitOps {
  assertSafeCompanionRoot(companionPath, workingRepoPath);
  const git = companionGit(companionPath, { prompt: "never", env: options.env });
  const exec = async (args: readonly string[]) => {
    const res = await git.run(args);
    return { status: res.status, out: res.stdout.trimEnd(), err: res.stderr.trim() };
  };
  const execOrThrow = async (args: string[]) => {
    const res = await exec(args);
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.err || res.out}`);
    }
    return res;
  };
  return {
    async currentBranch() {
      const res = await exec(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      return res.status === 0 && res.out.length > 0 ? res.out : null;
    },
    async defaultBranch() {
      // A configured remote HEAD is the only answer the remote itself asserts; the
      // rest are local conventions, narrowing to git's own default last.
      const remoteHead = await exec([
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      if (remoteHead.status === 0 && remoteHead.out.length > 0) {
        return remoteHead.out.replace(/^origin\//, "");
      }
      const configured = await exec(["config", "--get", "init.defaultBranch"]);
      if (configured.status === 0 && configured.out.length > 0) return configured.out;
      return "main";
    },
    async changedPaths() {
      const out = (await exec(["status", "--porcelain"])).out;
      if (out.length === 0) return [];
      return out.split("\n").map(parsePorcelainPath);
    },
    async changedPathKinds() {
      const out = (await exec(["status", "--porcelain"])).out;
      if (out.length === 0) return {};
      return Object.fromEntries(
        out.split("\n").map((line) => [parsePorcelainPath(line), parsePorcelainKind(line)]),
      );
    },
    async stagedPaths() {
      const out = (await exec(["diff", "--cached", "--name-only"])).out;
      return out.length === 0 ? [] : out.split("\n");
    },
    async add(paths) {
      const applicable = await filterPaths(
        paths,
        async (filePath) =>
          (await exec(["ls-files", "--cached", "--others", "--exclude-standard", "--", filePath]))
            .out.length > 0,
      );
      if (applicable.length > 0) {
        await execOrThrow(["add", "--", ...applicable]);
      }
    },
    async hasStagedChanges(paths) {
      // `diff --cached --quiet` exits 1 when there ARE staged changes.
      const pathspec = paths && paths.length > 0 ? ["--", ...paths] : [];
      return (await exec(["diff", "--cached", "--quiet", ...pathspec])).status !== 0;
    },
    async commit(message, paths) {
      // A produced path can be unknown to git entirely — e.g. an active change dir that
      // was never committed and has just been moved into the archive. `git commit` rejects
      // such pathspecs ("did not match any file(s) known to git"), so keep only paths that
      // exist in the index or in HEAD (staged deletions match HEAD, new files the index).
      const known = await filterPaths(
        paths ?? [],
        async (filePath) =>
          (await exec(["ls-files", "--cached", "--", filePath])).out.length > 0 ||
          (await exec(["ls-tree", "--name-only", "HEAD", "--", filePath])).out.length > 0,
      );
      const pathspec = known.length > 0 ? ["--", ...known] : [];
      if (paths && paths.length > 0 && known.length === 0) return;
      await execOrThrow(["commit", "-m", message, ...pathspec]);
    },
    async hasUpstream() {
      return (
        (await exec(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).status === 0
      );
    },
    async fetch() {
      const res = await git.fetch();
      if (res.status !== 0) throw new Error(`git fetch failed: ${remoteFailureDetail(res)}`);
    },
    async rebaseOntoUpstream() {
      const res = await exec(["rebase", "--autostash", "@{u}"]);
      const conflicts = await exec(["diff", "--name-only", "--diff-filter=U"]);
      if (res.status === 0 && conflicts.out.length === 0) {
        return { ok: true, conflictedPaths: [] };
      }
      return {
        ok: false,
        conflictedPaths: conflicts.out.length > 0 ? conflicts.out.split("\n") : [],
      };
    },
    async tagExists(name) {
      return (await exec(["tag", "--list", name])).out.length > 0;
    },
    async tag(name, message) {
      await execOrThrow(["tag", "-a", name, "-m", message]);
    },
    async push() {
      const res = await git.push(["--follow-tags"]);
      return { ok: res.status === 0, error: res.status === 0 ? "" : remoteFailureDetail(res) };
    },
  };
}
