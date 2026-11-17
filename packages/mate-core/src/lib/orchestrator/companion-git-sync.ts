// Git index and merge operations must remain sequential.
// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import {
  companionGit,
  describeGitFailure,
  isAuthenticationFailure,
  outputLines,
  type GitResult,
  type UpstreamTarget,
} from "../../runtime/companion-git";
import { recordCompanionSync } from "../../runtime/companion-git-state";
import { errorMessage } from "../../runtime/error-message";
import { withCompanionLock, type CompanionLockOptions } from "../../runtime/companion-lock";
import { inboxRefspec, trackingRefs } from "../../runtime/pending-records";
import {
  discardSubmittedArrivals,
  editedAfterSubmitWarning,
  planSubmittedArrivals,
  type SubmittedLayout,
} from "../../runtime/submitted-arrivals";
import { FRAMEWORK_NAME } from "../../framework";
import { defaultArtifactType } from "../delivery/staging/registry";
import { LaunchPreflightError } from "./types";

type GitCommandResult = GitResult;

export { describeGitFailure };

export interface CompanionGitSyncOptions {
  /** Environment Git runs with. */
  env?: Record<string, string | undefined>;
  /** Home of Mate's local companion state; `HOME` by default. */
  stateHome?: string;
}

export interface CompanionGitSyncResult {
  skipped: boolean;
  changed: boolean;
  companionPath: string;
  /** Submitted change folders discarded because their upstream copy or archive arrived. */
  discarded?: string[];
  /** Operator warnings, such as a submitted folder edited after submit. */
  warnings?: string[];
}

/** The default artifact type's folders, as the arrival check reads them. */
function submittedLayout(): SubmittedLayout {
  const type = defaultArtifactType();
  return {
    source: type.source,
    archiveRoot: type.archiveRoot,
    recordName: (id) => (type.isRecordId(id) ? type.recordName(id) : null),
  };
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

const MANAGED_ROOTS = [".mate", ".opencode", ".claude", ".agents", ".graphify"];

type SyncTarget = UpstreamTarget;

function isManagedPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return MANAGED_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export class CompanionGitSync {
  constructor(private readonly options: CompanionGitSyncOptions = {}) {}

  async sync(
    companionPath: string,
    workingRepoPath?: string,
    interactiveGit = false,
  ): Promise<CompanionGitSyncResult> {
    if (!(await this.assertSafeCompanionRoot(companionPath, workingRepoPath))) {
      return { skipped: true, changed: false, companionPath };
    }

    await this.assertNoUnfinishedOperation(companionPath);
    const target = await this.resolveSyncTarget(companionPath);

    const fetch = await this.fetch(companionPath, target, interactiveGit);
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

    const localGit = companionGit(companionPath, { prompt: "never", env: this.options.env });
    const arrivals = await planSubmittedArrivals(
      localGit,
      companionPath,
      target.ref,
      submittedLayout(),
      this.options.stateHome,
    );
    const discarded = await discardSubmittedArrivals(
      localGit,
      companionPath,
      arrivals,
      this.options.stateHome,
    );
    const warnings = arrivals.edited.map(editedAfterSubmitWarning);

    const before = await this.command(companionPath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (before.status !== 0) {
      const lost = await restoreFailure(discarded);
      const failure = this.failure(
        companionPath,
        `Unable to inspect the working tree: ${this.detail(before)}`,
      );
      throw withRestoreNote(companionPath, failure, lost);
    }
    const dirty = outputLines(before.stdout).length > 0;

    let result: CompanionGitSyncResult;
    try {
      result = await this.mergeUpstream(
        companionPath,
        target,
        dirty,
        discarded.discarded,
        warnings,
      );
    } catch (error) {
      // A file the merge brought stays; only paths still missing get their submitted copy back.
      const lost = await restoreFailure(discarded);
      throw withRestoreNote(companionPath, error, lost);
    }
    await discarded.commit();
    return result;
  }

  private async mergeUpstream(
    companionPath: string,
    target: SyncTarget,
    dirty: boolean,
    discarded: string[],
    warnings: string[],
  ): Promise<CompanionGitSyncResult> {
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
    /** Best-effort bookkeeping: a launch that synchronized must not fail on it. */
    recordCompanionSync(companionPath);
    return {
      skipped: false,
      changed: headBefore.stdout.trim() !== headAfter.stdout.trim(),
      companionPath,
      ...(discarded.length > 0 ? { discarded } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /**
   * Only this fetch may prompt, and only when the caller is interactive. The inbox rides along
   * for the pending count.
   */
  private async fetch(
    companionPath: string,
    target: SyncTarget,
    interactiveGit: boolean,
  ): Promise<GitCommandResult> {
    const git = companionGit(companionPath, {
      prompt: interactiveGit ? "if-terminal" : "never",
      env: this.options.env,
    });
    const fetched = await git.fetch([target.remote, target.branch, inboxRefspec(target.remote)]);
    if (fetched.status !== 0) return fetched;
    // Publication lands on the default branch; a checkout tracking another branch fetches it too.
    const prefix = `refs/remotes/${target.remote}/`;
    const defaultRef = (await trackingRefs(companionPath))?.defaultRef;
    if (defaultRef?.startsWith(prefix) && defaultRef !== `${prefix}${target.branch}`) {
      const branch = defaultRef.slice(prefix.length);
      await git.fetch([target.remote, `+refs/heads/${branch}:${defaultRef}`]);
    }
    return fetched;
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
      await this.dropStash(companionPath, stashRef);
    }
  }

  /** Drops the stash entry holding commit `stashRef`: `git stash drop` takes no commit id. */
  private async dropStash(companionPath: string, stashRef: string): Promise<void> {
    const listed = await this.command(companionPath, ["stash", "list", "--format=%H"]);
    if (listed.status !== 0) return;
    const index = outputLines(listed.stdout).indexOf(stashRef);
    if (index >= 0) await this.command(companionPath, ["stash", "drop", "-q", `stash@{${index}}`]);
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

  /**
   * Delegates to `runtime/`: the blind half resolves the same ref, and the two
   * must never disagree about which upstream they mean.
   */
  private async resolveSyncTarget(companionPath: string): Promise<SyncTarget> {
    const target = await companionGit(companionPath, {
      prompt: "never",
      env: this.options.env,
    }).upstreamTarget();
    if (target) return target;

    throw this.failure(
      companionPath,
      "No configured upstream branch is available for synchronization.",
      [],
      "Set an upstream with `git branch --set-upstream-to <remote>/<branch>`, then retry.",
    );
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

  private command(companionPath: string, args: readonly string[]): Promise<GitCommandResult> {
    return companionGit(companionPath, { prompt: "never", env: this.options.env }).run(args);
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

/** Puts discarded submitted files back; a failure, naming where they are kept, is returned. */
async function restoreFailure(discarded: { restore: () => Promise<void> }): Promise<string | null> {
  return discarded.restore().then(
    () => null,
    (error: unknown) => `Putting back discarded submitted folders failed: ${errorMessage(error)}.`,
  );
}

/** `error`, its reason extended by `note` when restoring failed too. */
function withRestoreNote(companionPath: string, error: unknown, note: string | null): unknown {
  if (!note) return error;
  if (error instanceof CompanionGitSyncError) {
    return new CompanionGitSyncError(
      companionPath,
      `${error.reason} ${note}`,
      error.conflictingPaths,
      error.recovery,
      error.stashRef,
    );
  }
  return new CompanionGitSyncError(companionPath, `${errorMessage(error)} ${note}`);
}

/**
 * An attended operation waits for whoever holds the companion lock, however
 * long: the holder may be an operator answering a merge conflict. The line
 * explains the pause; a crashed holder frees the lock by itself.
 */
export function attendedLockOptions(companionPath: string): CompanionLockOptions {
  return {
    timeoutMs: Number.POSITIVE_INFINITY,
    onWait: () =>
      console.error(
        `${FRAMEWORK_NAME}: waiting for another companion sync to finish (${companionPath})…`,
      ),
  };
}

/** Serialized with every other synchronization of this companion. */
export async function syncCompanionGit(
  companionPath: string,
  workingRepoPath?: string,
  interactiveGit = false,
): Promise<CompanionGitSyncResult> {
  const locked = await withCompanionLock(companionPath, attendedLockOptions(companionPath), () =>
    new CompanionGitSync().sync(companionPath, workingRepoPath, interactiveGit),
  );
  if (!locked.acquired) {
    throw new CompanionGitSyncError(
      companionPath,
      "Another companion synchronization is still running.",
    );
  }
  return locked.value;
}
