// Git index and merge operations must remain sequential.
// oxlint-disable no-await-in-loop
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { LaunchPreflightError } from "./types";

const execFile = promisify(execFileCallback);

export interface GitCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitCommandResult>;

export interface CompanionGitSyncResult {
  skipped: boolean;
  changed: boolean;
  companionPath: string;
}

export class CompanionGitSyncError extends LaunchPreflightError {
  readonly companionPath: string;
  readonly conflictingPaths: string[];

  constructor(
    companionPath: string,
    reason: string,
    conflictingPaths: string[] = [],
    recovery = "Resolve or abort the Git operation, then retry the launch.",
  ) {
    const conflicts = conflictingPaths.length
      ? `\n  Conflicting paths:\n${conflictingPaths.map((entry) => `    - ${entry}`).join("\n")}`
      : "";
    super(
      [
        "mate: companion Git synchronization failed.",
        `  Companion: ${companionPath}`,
        `  ${reason}`,
        conflicts,
        `  ${recovery}`,
        "  Bypass: `mate claude -- --no-git` or `mate opencode -- --no-git`.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    this.name = "CompanionGitSyncError";
    this.companionPath = companionPath;
    this.conflictingPaths = conflictingPaths;
  }
}

export const companionGitSyncDeps: { runGit: GitRunner } = {
  runGit: async (args, cwd) => {
    try {
      const {
        GIT_DIR: _gitDir,
        GIT_WORK_TREE: _gitWorkTree,
        GIT_COMMON_DIR: _gitCommonDir,
        GIT_INDEX_FILE: _gitIndexFile,
        ...gitEnv
      } = process.env;
      const result = await execFile("git", [...args], {
        cwd,
        encoding: "utf8",
        env: gitEnv,
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

export class CompanionGitSync {
  constructor(private readonly runGit: GitRunner = companionGitSyncDeps.runGit) {}

  async sync(companionPath: string, workingRepoPath?: string): Promise<CompanionGitSyncResult> {
    if (!(await this.assertSafeCompanionRoot(companionPath, workingRepoPath))) {
      return { skipped: true, changed: false, companionPath };
    }

    await this.assertNoUnfinishedOperation(companionPath);
    const target = await this.resolveSyncTarget(companionPath);
    const before = await this.command(companionPath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (before.status !== 0) {
      throw this.failure(
        companionPath,
        `Unable to inspect the working tree: ${this.detail(before)}`,
      );
    }
    const dirty = outputLines(before.stdout).length > 0;

    const fetch = await this.command(companionPath, ["fetch", target.remote, target.branch]);
    if (fetch.status !== 0) {
      throw this.failure(
        companionPath,
        `Unable to fetch ${target.ref}: ${this.detail(fetch)}`,
        [],
        "Check the remote and network, or resolve the issue before retrying.",
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

    const merge = await this.command(companionPath, ["merge", target.ref, "--no-edit"]);
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

    return {
      skipped: false,
      changed: merge.status === 0 && merge.stdout.trim() !== "",
      companionPath,
    };
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
    const found: string[] = [];
    for (const name of unfinished) {
      if (await this.hasGitPath(companionPath, name)) found.push(name);
    }
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

  private async command(companionPath: string, args: readonly string[]): Promise<GitCommandResult> {
    return this.runGit(args, companionPath);
  }

  private detail(result: GitCommandResult): string {
    return (result.stderr || result.stdout || "unknown Git error").trim();
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
): Promise<CompanionGitSyncResult> {
  return new CompanionGitSync(companionGitSyncDeps.runGit).sync(companionPath, workingRepoPath);
}
