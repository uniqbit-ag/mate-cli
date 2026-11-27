import { randomUUID } from "node:crypto";

import { TRANSACTION_TRAILER } from "../../../../lib/artifact-trailer";
import type { BranchOutcome } from "../../../../lib/delivery/refresh";
import type { PublicationConflict, PublishedClaim } from "../../../../lib/delivery/staging/publish";
import type { PruneResult } from "../../../../lib/workset/worktree";
import { describeSecretFindings, type SecretFinding } from "../../../../runtime/secret-scan";
import type { ArtifactFinisher, Produced } from "./finisher";
import { RemoteFetchError, type GitOps } from "./git";
import type { PublicationSecretScan } from "./secret-scan";

/** Pipeline step a {@link FinishResult} refers to (generic across artifact kinds). */
export type FinishStep =
  | "resolve"
  | "branch-guard"
  | "cap-sync"
  | "secret-scan"
  | "commit"
  | "sync-remote"
  | "publish"
  | "push"
  | "done";

/**
 * `deferred`: a remote step stayed unreachable after retries; local work is kept and a re-run
 * completes it. `held`: a Delivery Group waits for its merge or an unpublished dependency.
 * `awaiting-publisher`: ready, but this user may not push the default branch.
 */
export type FinishStatus =
  | "ok"
  | "conflict"
  | "error"
  | "skipped"
  | "deferred"
  | "held"
  | "awaiting-publisher";

/**
 * Machine-readable result emitted with `--json`. The publish skill parses this to
 * decide whether to hand a conflict to a human or to retry. Publication creates no tag:
 * `tag` is always null and `local.tagged` always false; `commit` names what was published.
 */
export interface FinishResult {
  type: string;
  name: string;
  anchorName: string | null;
  tag: null;
  /** The published commit: the Delivery Group's, or the local publication commit. */
  commit?: string;
  /** The Delivery Group a change publication published or held. */
  group?: string;
  /** The group's submitted changes, in publication order. */
  changes?: string[];
  /** The archives the group's changes became. */
  anchors?: string[];
  /** Why a group is held: `unmerged`, `dependency-unpublished` or `unconfirmed-merge`. */
  reason?: "unmerged" | "dependency-unpublished" | "unconfirmed-merge";
  /** The final merge results the group's changes record and who recorded each. */
  merges?: PublishedClaim[];
  /** `unmerged` after `--refresh`: the branch lookups that need the user's answer. */
  outcomes?: BranchOutcome[];
  /** `dependency-unpublished`: the changes of other groups it waits for. */
  heldBy?: string[];
  /** Groups of dependencies published first in the same run. */
  dependencies?: FinishResult[];
  /** The conflict is recorded as `blocked` on the pending branch. */
  blocked?: boolean;
  /** A requirement changed since the delta was written, with the texts to resolve it from. */
  conflict?: PublicationConflict;
  /** True when a prior publication already committed or pushed this publication. */
  resumed: boolean;
  step: FinishStep;
  status: FinishStatus;
  conflictedPaths: string[];
  local: { committed: boolean; tagged: false; pushed: boolean };
  message: string;
  /** Set when the secret scan stopped the publication: where and which rule, never the value. */
  secretFindings?: SecretFinding[];
  /** The finisher's warning about what it resolved; publication continued. */
  warning?: string;
  /**
   * Set on the result whose publication made a Workset Done: the worktrees cleaned up
   * after it. Best effort; it never changes `status`.
   */
  worktrees?: PruneResult;
}

export interface EngineOptions {
  name: string;
  noPush: boolean;
}

export interface EngineDeps {
  git: GitOps;
  json: boolean;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Scans the staged outputs for secrets; absent means no scan step. */
  secretScan?: (commitPaths: string[]) => Promise<PublicationSecretScan>;
  /** False leaves printing the result to the caller; progress lines still go to stderr. */
  printResult?: boolean;
}

/**
 * Prints a result: the message on stdout when it succeeded, stderr otherwise; with `json`, the
 * JSON document on stdout, plus the message on stderr otherwise.
 */
export function printFinishResult(
  result: FinishResult,
  out: Pick<EngineDeps, "json" | "stdout" | "stderr">,
): void {
  const succeeded = result.status === "ok" || result.status === "skipped";
  if (!succeeded) out.stderr(result.message);
  if (out.json) out.stdout(JSON.stringify(result));
  else if (succeeded) out.stdout(result.message);
}

/** The publication commit's message: subject, then its `Mate-*` trailers. */
function commitMessage(subject: string, trailers: Record<string, string>): string {
  const lines = Object.entries(trailers).map(([key, value]) => `${key}: ${value}`);
  return `${subject}\n\n${lines.join("\n")}`;
}

/**
 * Runs the local publication pipeline for a resolved {@link ArtifactFinisher}:
 * resolve → branch guard → cap sync → secret scan → scoped commit → sync-remote → push.
 * The commit carries `Mate-*` trailers instead of a tag.
 *
 * Isolation is a clean abort, not a rollback: the resolved artifact is durable input
 * the pipeline never produced, so no step resets, restores, or deletes a path.
 */
export async function runFinishEngine(
  finisher: ArtifactFinisher,
  options: EngineOptions,
  deps: EngineDeps,
): Promise<FinishResult> {
  const { git } = deps;

  const result: FinishResult = {
    type: finisher.type,
    name: options.name,
    anchorName: null,
    tag: null,
    resumed: false,
    step: "resolve",
    status: "ok",
    conflictedPaths: [],
    local: { committed: false, tagged: false, pushed: false },
    message: "",
  };

  const emit = (): void => {
    if (deps.printResult !== false) printFinishResult(result, deps);
  };

  /** Exits zero: the publication is kept locally and resumable, so it must not block the caller. */
  const defer = (step: FinishStep, kept: string, detail: string): void => {
    result.step = step;
    result.status = "deferred";
    result.message = `mate: ${step === "push" ? "push" : "fetch"} deferred (${kept}); the remote stayed unreachable after retries, which may be transient. Re-run \`mate artifact publish\` to complete the publication.\n${detail}`;
    emit();
  };

  /** The publication commit, once committed (and rebased). */
  const recordCommit = async (): Promise<void> => {
    const commit = await git.headCommit?.().catch(() => null);
    if (commit) result.commit = commit;
  };

  const fail = (step: FinishStep, message: string, status: FinishStatus = "error"): void => {
    result.step = step;
    result.status = status;
    result.message = message;
    emit();
    process.exitCode = 1;
  };

  // Resolve the already-produced artifact. Nothing is mutated, so a refusal here — an
  // unarchived target, or a name matching two archives — leaves the companion untouched.
  result.step = "resolve";
  const resolution = await finisher.resolve(options.name);
  if (!resolution.ok) {
    fail("resolve", resolution.message);
    return result;
  }
  const resolved: Produced = resolution.resolved;
  result.anchorName = resolved.anchorName;
  if (resolved.warning) {
    result.warning = resolved.warning;
    if (!deps.json) deps.stderr(`warning: ${resolved.warning}`);
  }

  // Branch guard — before cap sync, so a refusal mutates nothing at all. It applies to
  // --no-push too: the local commit it creates is what a later push would publish.
  result.step = "branch-guard";
  const [expectedBranch, currentBranch] = await Promise.all([
    git.defaultBranch(),
    git.currentBranch(),
  ]);
  if (currentBranch === null) {
    fail(
      "branch-guard",
      `mate: publication requires the companion's default branch (${expectedBranch}); HEAD is detached.`,
    );
    return result;
  }
  if (currentBranch !== expectedBranch) {
    fail(
      "branch-guard",
      `mate: refusing to publish from ${currentBranch}; the companion's default branch is ${expectedBranch}.`,
    );
    return result;
  }

  // Capability sync (only openspec-derived outputs are refreshed; commit stays scoped).
  if (finisher.capSync) {
    result.step = "cap-sync";
    if (!(await finisher.capSync())) {
      fail(
        "cap-sync",
        "mate: cap sync failed; the resolved archive was left in place — re-run `mate artifact publish` to retry.",
      );
      return result;
    }
  }

  // Secret scan — the last pre-commit step, over exactly what the commit would stage.
  // A finding or a scanner failure stops here like any pre-commit failure: no commit,
  // no tag, no push, and the archive stays on disk.
  if (deps.secretScan) {
    result.step = "secret-scan";
    let scan: PublicationSecretScan;
    try {
      scan = await deps.secretScan(resolved.commitPaths);
    } catch (err) {
      fail(
        "secret-scan",
        `mate: the secret scan failed (${String(err)}); nothing was committed — re-run \`mate artifact publish\` to retry.`,
      );
      return result;
    }
    if (scan.skipped) {
      deps.stderr("mate: secret scan skipped (secrets.guardrails is false in framework.yaml).");
    } else if (scan.findings.length > 0) {
      result.secretFindings = scan.findings;
      fail(
        "secret-scan",
        [
          "mate: refusing to publish: the staged outputs contain secrets. Nothing was committed; the archive was left in place.",
          ...describeSecretFindings(scan.findings).map((line) => ` ${line}`),
          "Replace each value with a placeholder or variable name, then re-run `mate artifact publish`.",
        ].join("\n"),
      );
      return result;
    }
  }

  // Commit — stage only the finisher's scoped paths. Nothing to stage means a prior
  // publication already committed this anchor, which is a resume rather than an error.
  result.step = "commit";
  try {
    await git.add(resolved.commitPaths);
    if (await git.hasStagedChanges(resolved.commitPaths)) {
      await git.commit(
        commitMessage(
          resolved.commitSubject ?? `chore(${finisher.type}): finish ${resolved.anchorName}`,
          { ...resolved.trailers, [TRANSACTION_TRAILER]: randomUUID() },
        ),
        resolved.commitPaths,
      );
    } else {
      result.resumed = true;
    }
  } catch (err) {
    fail(
      "commit",
      `mate: commit failed: ${String(err)}; the resolved archive was left in place — re-run \`mate artifact publish\` to retry.`,
    );
    return result;
  }
  result.local.committed = true;

  // Sync with remote before pushing (skipped with --no-push — no remote target).
  if (!options.noPush) {
    result.step = "sync-remote";
    if (await git.hasUpstream()) {
      try {
        await git.fetch();
      } catch (err) {
        // Post-commit failure: retain the commit, do not roll back.
        if (err instanceof RemoteFetchError && err.transient) {
          defer("sync-remote", "commit retained locally, not pushed", err.message);
        } else {
          fail("sync-remote", `mate: fetch failed (commit retained locally): ${String(err)}`);
        }
        return result;
      }
      const rebase = await git.rebaseOntoUpstream();
      if (!rebase.ok) {
        // Deliberate stop-for-handoff: commit exists, not pushed. Never auto-resolve.
        result.step = "sync-remote";
        result.status = "conflict";
        result.conflictedPaths = rebase.conflictedPaths;
        result.message =
          "mate: rebase onto remote conflicted; resolve the conflict, complete the rebase, then publish again to push.";
        emit();
        process.exitCode = 1;
        return result;
      }
    }
  }

  if (options.noPush) {
    await recordCommit();
    result.step = "done";
    result.status = "skipped";
    result.message = `Published ${resolved.anchorName} locally (committed); not pushed (--no-push).`;
    emit();
    return result;
  }

  // Push the branch; `--follow-tags` still carries a tag an older Mate version created.
  result.step = "push";
  const push = await git.push();
  if (!push.ok) {
    // Post-commit push failure: retain the commit for retry, do not roll back.
    if (push.transient) {
      defer("push", "commit retained locally", push.error);
      return result;
    }
    result.status = "error";
    result.message = `mate: push failed (commit retained locally): ${push.error}`;
    emit();
    process.exitCode = 1;
    return result;
  }
  result.local.pushed = true;
  await recordCommit();

  result.step = "done";
  result.status = "ok";
  result.message = `Published ${resolved.anchorName}: ${result.resumed ? "resumed, " : ""}committed and pushed.`;
  emit();
  return result;
}
