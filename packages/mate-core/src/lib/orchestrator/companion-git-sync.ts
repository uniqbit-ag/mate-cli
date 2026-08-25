// Git index and merge operations must remain sequential.
// oxlint-disable no-await-in-loop
import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { LaunchPreflightError } from "./types";

const execFile = promisify(execFileCallback);

/** Bounded but far above any diagnostic output; default 1 MiB kills git mid-merge on large trees. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface GitCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type GitExecutionMode = "captured" | "interactive";

export type GitRunner = (
  args: readonly string[],
  cwd: string,
  mode?: GitExecutionMode,
) => Promise<GitCommandResult>;

export interface CompanionGitSyncResult {
  skipped: boolean;
  changed: boolean;
  companionPath: string;
}

export class CompanionGitSyncError extends LaunchPreflightError {
  readonly companionPath: string;
  readonly conflictingPaths: string[];
  readonly reason: string;
  readonly recovery: string;
  readonly stashRef: string | undefined;

  constructor(
    companionPath: string,
    reason: string,
    conflictingPaths: string[] = [],
    recovery = "Resolve or abort the Git operation, then retry the launch.",
    stashRef?: string,
  ) {
    const conflicts = conflictingPaths.length
      ? `\n  Conflicting paths:\n${conflictingPaths.map((entry) => `    - ${entry}`).join("\n")}`
      : "";
    const stash = stashRef
      ? `  Local changes were stashed as ${stashRef}. Recover with \`git stash apply ${stashRef}\` in the companion.`
      : "";
    super(
      [
        "mate: companion Git synchronization failed.",
        `  Companion: ${companionPath}`,
        `  ${reason}`,
        conflicts,
        stash,
        `  ${recovery}`,
        "  Bypass: `mate claude -- --no-git` or `mate opencode -- --no-git`.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    this.name = "CompanionGitSyncError";
    this.companionPath = companionPath;
    this.conflictingPaths = conflictingPaths;
    this.reason = reason;
    this.recovery = recovery;
    this.stashRef = stashRef;
  }
}

export const companionGitSyncDeps: { runGit: GitRunner } = {
  runGit: async (args, cwd, mode = "captured") => {
    const {
      GIT_DIR: _gitDir,
      GIT_WORK_TREE: _gitWorkTree,
      GIT_COMMON_DIR: _gitCommonDir,
      GIT_INDEX_FILE: _gitIndexFile,
      GIT_TERMINAL_PROMPT: _gitTerminalPrompt,
      ...gitEnv
    } = process.env;
    const env = mode === "captured" ? { ...gitEnv, GIT_TERMINAL_PROMPT: "0" } : gitEnv;

    if (mode === "interactive") {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (result: GitCommandResult) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };

        const child = spawnChild("git", [...args], {
          cwd,
          env,
          stdio: "inherit",
        });
        child.once("error", (error) => {
          finish({ status: 1, stdout: "", stderr: error.message });
        });
        child.once("close", (status) => {
          finish({ status: status ?? 1, stdout: "", stderr: "" });
        });
      });
    }

    try {
      const result = await execFile("git", [...args], {
        cwd,
        encoding: "utf8",
        env,
        maxBuffer: GIT_MAX_BUFFER,
      });
      return { status: 0, stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (error) {
      const commandError = error as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      return {
        status: typeof commandError.code === "number" ? commandError.code : 1,
        stdout: commandError.stdout ?? "",
        stderr: commandError.stderr ?? commandError.message ?? "",
      };
    }
  },
};

const MANAGED_ROOTS = [".mate", ".opencode", ".claude", ".agents", ".graphify"];

interface SyncTarget {
  remote: string;
  branch: string;
  ref: string;
}

function isManagedPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return MANAGED_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function outputLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Matches Git progress-meter lines such as `Updating files:  76% (11340/14790)` or `..., done.` */
const GIT_PROGRESS_LINE = /^\S.*?: +\d+% \(\d+\/\d+\)(?:, done\.)?$/;

function stripGitProgress(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => !GIT_PROGRESS_LINE.test(line.trim()))
    .join("\n")
    .trim();
}

function isAuthenticationFailure(result: GitCommandResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return [
    "terminal prompts disabled",
    "could not read username",
    "could not read password",
    "authentication failed",
    "permission denied (publickey)",
    "could not open /dev/tty",
    "can't open /dev/tty",
    "cannot open /dev/tty",
  ].some((marker) => output.includes(marker));
}

export function describeGitFailure(result: GitCommandResult): string {
  return stripGitProgress(result.stderr) || stripGitProgress(result.stdout) || "unknown Git error";
}

export class CompanionGitSync {
  constructor(private readonly runGit: GitRunner = companionGitSyncDeps.runGit) {}

  async sync(
    companionPath: string,
    workingRepoPath?: string,
    interactiveGit = false,
  ): Promise<CompanionGitSyncResult> {
    if (!(await this.assertSafeCompanionRoot(companionPath, workingRepoPath))) {
      return { skipped: true, changed: false, companionPath };
    }

    await this.assertNoUnfinishedOperation(companionPath);
    const [target, before] = await Promise.all([
      this.resolveSyncTarget(companionPath),
      this.command(companionPath, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ]);
    if (before.status !== 0) {
      throw this.failure(
        companionPath,
        `Unable to inspect the working tree: ${this.detail(before)}`,
      );
    }
    const dirty = outputLines(before.stdout).length > 0;

    const fetch = await this.command(
      companionPath,
      ["fetch", target.remote, target.branch],
      interactiveGit ? "interactive" : undefined,
    );
    if (fetch.status !== 0) {
      const authenticationFailure = isAuthenticationFailure(fetch);
      const recovery = interactiveGit
        ? authenticationFailure
          ? "Retry the launch and complete Git authentication, or use the `--no-git` bypass."
          : "Check the Git or SSH diagnostics above, then retry the launch."
        : authenticationFailure
          ? "Provide credentials through a non-interactive Git credential helper or SSH agent, retry from a terminal, or use the `--no-git` bypass."
          : "Check the remote and network, or resolve the issue before retrying.";
      const detail = this.detail(fetch);
      const failureDetail =
        interactiveGit && detail === "unknown Git error"
          ? "Git fetch failed; review the Git or SSH diagnostics above."
          : detail;
      throw this.failure(
        companionPath,
        `Unable to fetch ${target.ref}: ${failureDetail}`,
        [],
        recovery,
      );
    }

    let stashRef: string | undefined;
    if (dirty) {
      const stash = await this.command(companionPath, [
        "stash",
        "push",
        "--include-untracked",
        "--message",
        "mate companion launch preflight",
      ]);
      if (stash.status !== 0) {
        throw this.failure(
          companionPath,
          `Unable to preserve local changes: ${this.detail(stash)}`,
        );
      }

      const ref = await this.command(companionPath, ["rev-parse", "stash@{0}"]);
      if (ref.status !== 0 || !ref.stdout.trim()) {
        throw this.failure(companionPath, "Git did not create a recoverable local-change stash.");
      }
      stashRef = ref.stdout.trim();
    }

    const headBefore = await this.command(companionPath, ["rev-parse", "HEAD"]);
    try {
      await this.mergeAndRestore(companionPath, target, stashRef);
    } catch (error) {
      if (stashRef && error instanceof CompanionGitSyncError && !error.stashRef) {
        throw new CompanionGitSyncError(
          error.companionPath,
          error.reason,
          error.conflictingPaths,
          error.recovery,
          stashRef,
        );
      }
      throw error;
    }

    const headAfter = await this.command(companionPath, ["rev-parse", "HEAD"]);
    return {
      skipped: false,
      changed: headBefore.stdout.trim() !== headAfter.stdout.trim(),
      companionPath,
    };
  }

  private async mergeAndRestore(
    companionPath: string,
    target: SyncTarget,
    stashRef: string | undefined,
  ): Promise<void> {
    const merge = await this.command(companionPath, [
      "merge",
      target.ref,
      "--no-stat",
      "--no-progress",
      "--no-edit",
    ]);
    if (merge.status !== 0) {
      await this.resolveManagedConflicts(companionPath, target.ref);
      const conflicts = await this.unresolvedPaths(companionPath);
      if (conflicts.length > 0) {
        throw this.failure(
          companionPath,
          "The merge left unresolved non-managed conflicts.",
          conflicts,
          "Resolve the paths and complete the merge, or run `git merge --abort`.",
        );
      }

      if (await this.hasGitPath(companionPath, "MERGE_HEAD")) {
        const commit = await this.command(companionPath, ["commit", "--no-edit"]);
        if (commit.status !== 0) {
          throw this.failure(companionPath, `Unable to complete the merge: ${this.detail(commit)}`);
        }
      } else {
        throw this.failure(companionPath, `Unable to merge ${target.ref}: ${this.detail(merge)}`);
      }
    }

    if (stashRef) {
      const apply = await this.command(companionPath, ["stash", "apply", "--index", stashRef]);
      if (apply.status !== 0) {
        const applyConflicts = await this.unresolvedPaths(companionPath);
        await this.resolveManagedConflicts(companionPath, target.ref);
        const conflicts = await this.unresolvedPaths(companionPath);
        if (conflicts.length > 0) {
          throw this.failure(
            companionPath,
            "Restoring unrelated local changes left unresolved conflicts.",
            conflicts,
            "Resolve the paths and remove the saved stash when recovery is complete.",
          );
        }
        if (applyConflicts.length === 0) {
          throw this.failure(
            companionPath,
            `Restoring unrelated local changes failed: ${this.detail(apply)}`,
            [],
            "Resolve the collision and remove the saved stash when recovery is complete.",
          );
        }
      }

      await this.discardManagedChanges(companionPath);
      const remaining = await this.unresolvedPaths(companionPath);
      if (remaining.length > 0) {
        throw this.failure(
          companionPath,
          "Local changes remain in an unresolved state.",
          remaining,
        );
      }

      // Keep the stash if dropping it fails; it remains a recoverable backup.
      await this.command(companionPath, ["stash", "drop", stashRef]);
    }
  }

  private async assertSafeCompanionRoot(
    companionPath: string,
    workingRepoPath?: string,
  ): Promise<boolean> {
    const companionRoot = await this.resolvedPath(companionPath);
    const workingRoot = workingRepoPath ? await this.resolvedPath(workingRepoPath) : undefined;
    if (workingRoot && companionRoot === workingRoot) {
      throw this.failure(
        companionPath,
        "Refusing companion Git synchronization because companion and working repo are identical.",
      );
    }

    const gitRoot = await this.command(companionPath, ["rev-parse", "--show-toplevel"]);
    if (gitRoot.status !== 0) return false;
    if (companionRoot !== (await this.resolvedPath(gitRoot.stdout.trim()))) {
      throw this.failure(
        companionPath,
        "Refusing companion Git synchronization because companion is not a Git root.",
      );
    }
    return true;
  }

  private async resolvedPath(candidate: string): Promise<string> {
    try {
      return await fs.realpath(candidate);
    } catch {
      return path.resolve(candidate);
    }
  }

  private async resolveSyncTarget(companionPath: string): Promise<SyncTarget> {
    const upstream = await this.command(companionPath, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
    const configured = this.parseRemoteRef(upstream.stdout);
    if (upstream.status === 0 && configured) return configured;

    const remoteHead = await this.command(companionPath, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const fromRemoteHead = this.parseRemoteRef(remoteHead.stdout);
    if (remoteHead.status === 0 && fromRemoteHead) return fromRemoteHead;

    for (const branch of ["main", "master"]) {
      const exists = await this.command(companionPath, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${branch}`,
      ]);
      if (exists.status === 0) {
        return { remote: "origin", branch, ref: `origin/${branch}` };
      }
    }

    throw this.failure(
      companionPath,
      "No configured upstream branch is available for synchronization.",
      [],
      "Set an upstream with `git branch --set-upstream-to <remote>/<branch>`, then retry.",
    );
  }

  private parseRemoteRef(stdout: string): SyncTarget | undefined {
    const ref = stdout.trim();
    const separator = ref.indexOf("/");
    if (separator <= 0 || separator === ref.length - 1) return undefined;
    return {
      remote: ref.slice(0, separator),
      branch: ref.slice(separator + 1),
      ref,
    };
  }

  private async assertNoUnfinishedOperation(companionPath: string): Promise<void> {
    const unfinished = [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
    ];
    const present = await Promise.all(
      unfinished.map((name) => this.hasGitPath(companionPath, name)),
    );
    const found = unfinished.filter((_, index) => present[index]);
    if (found.length > 0) {
      throw this.failure(
        companionPath,
        `An unfinished Git operation is already present (${found.join(", ")}).`,
        [],
        "Resolve it or run the appropriate `git ... --abort` command before launching.",
      );
    }
  }

  private async hasGitPath(companionPath: string, name: string): Promise<boolean> {
    const gitPath = await this.command(companionPath, ["rev-parse", "--git-path", name]);
    if (gitPath.status !== 0) return false;
    const resolved = path.resolve(companionPath, gitPath.stdout.trim());
    try {
      await fs.access(resolved);
      return true;
    } catch {
      return false;
    }
  }

  private async unresolvedPaths(companionPath: string): Promise<string[]> {
    const result = await this.command(companionPath, ["diff", "--name-only", "--diff-filter=U"]);
    return result.status === 0 ? outputLines(result.stdout) : [];
  }

  private async resolveManagedConflicts(companionPath: string, targetRef: string): Promise<void> {
    const conflicts = await this.unresolvedPaths(companionPath);
    for (const conflict of conflicts.filter(isManagedPath)) {
      const restore = await this.command(companionPath, [
        "restore",
        `--source=${targetRef}`,
        "--staged",
        "--worktree",
        "--",
        conflict,
      ]);
      if (restore.status !== 0) {
        throw this.failure(
          companionPath,
          `Unable to resolve managed path from ${targetRef}: ${conflict}.`,
          [conflict],
        );
      }
      await this.command(companionPath, ["add", "-A", "--", conflict]);
    }
  }

  private async discardManagedChanges(companionPath: string): Promise<void> {
    const tracked = await this.command(companionPath, [
      "ls-files",
      "--cached",
      "--",
      ...MANAGED_ROOTS,
    ]);
    const trackedPaths = outputLines(tracked.stdout);
    if (trackedPaths.length > 0) {
      const restore = await this.command(companionPath, [
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--",
        ...trackedPaths,
      ]);
      if (restore.status !== 0) {
        throw this.failure(
          companionPath,
          `Unable to restore managed paths from HEAD: ${this.detail(restore)}`,
        );
      }
    }

    // -x is intentionally omitted: ignored files are local state and must survive.
    const clean = await this.command(companionPath, ["clean", "-fd", "--", ...MANAGED_ROOTS]);
    if (clean.status !== 0) {
      throw this.failure(
        companionPath,
        `Unable to remove unmanaged managed-path files: ${this.detail(clean)}`,
      );
    }
  }

  private async command(
    companionPath: string,
    args: readonly string[],
    mode?: GitExecutionMode,
  ): Promise<GitCommandResult> {
    return mode ? this.runGit(args, companionPath, mode) : this.runGit(args, companionPath);
  }

  private detail(result: GitCommandResult): string {
    return describeGitFailure(result);
  }

  private failure(
    companionPath: string,
    reason: string,
    paths: string[] = [],
    recovery?: string,
  ): CompanionGitSyncError {
    return new CompanionGitSyncError(companionPath, reason, paths, recovery);
  }
}

export async function syncCompanionGit(
  companionPath: string,
  workingRepoPath?: string,
  interactiveGit = false,
): Promise<CompanionGitSyncResult> {
  return new CompanionGitSync(companionGitSyncDeps.runGit).sync(
    companionPath,
    workingRepoPath,
    interactiveGit,
  );
}
