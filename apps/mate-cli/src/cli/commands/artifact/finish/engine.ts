import type { ArtifactFinisher, Produced } from "./finisher";
import type { GitOps } from "./git";

/** Pipeline step a {@link FinishResult} refers to (generic across artifact kinds). */
export type FinishStep =
  | "validate"
  | "complete-guard"
  | "dirty-guard"
  | "produce"
  | "cap-sync"
  | "commit"
  | "sync-remote"
  | "tag"
  | "push"
  | "done";

export type FinishStatus = "ok" | "conflict" | "error" | "skipped";

/**
 * Machine-readable result emitted with `--json`. The finish skill parses this to
 * decide whether to hand a rebase conflict to a human, or to drive the remaining
 * tag + push after resolving one.
 */
export interface FinishResult {
  type: string;
  name: string;
  anchorName: string | null;
  tag: string | null;
  /** True when the artifact was already produced and the engine skipped that step. */
  resumed: boolean;
  step: FinishStep;
  status: FinishStatus;
  conflictedPaths: string[];
  local: { committed: boolean; tagged: boolean; pushed: boolean };
  message: string;
}

export interface EngineOptions {
  name: string;
  force: boolean;
  noPush: boolean;
}

export interface EngineDeps {
  git: GitOps;
  json: boolean;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * Runs the fixed finish pipeline for a resolved {@link ArtifactFinisher}:
 * (validate → guards) → produce* → cap sync → scoped commit → sync-remote → tag → push,
 * where produce is skipped when the artifact is already produced (resume). The git,
 * remote-sync, conflict-handoff, and rollback machinery is identical for every
 * artifact kind — only the finisher's steps vary.
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
    step: "validate",
    status: "ok",
    conflictedPaths: [],
    local: { committed: false, tagged: false, pushed: false },
    message: "",
  };

  const emit = (): void => {
    if (deps.json) {
      deps.stdout(JSON.stringify(result));
    } else if (result.status === "ok" || result.status === "skipped") {
      deps.stdout(result.message);
    } else {
      deps.stderr(result.message);
    }
  };

  const fail = (step: FinishStep, message: string, status: FinishStatus = "error"): void => {
    result.step = step;
    result.status = status;
    result.message = message;
    emit();
    process.exitCode = 1;
  };

  // Resumable detection drives which guards apply and whether we produce.
  const existing = await finisher.detectProduced(options.name);
  const resuming = existing !== null;
  result.resumed = resuming;

  // Produce-time guards apply only to a fresh finish. An already-produced artifact
  // was validated at produce time and is no longer "active" to validate against.
  if (!resuming) {
    const validation = await finisher.validate(options.name);
    if (!validation.valid) {
      fail("validate", `mate: ${options.name} failed validation:\n${validation.errors.join("\n")}`);
      return result;
    }
    if (!options.force) {
      const completeness = await finisher.isComplete(options.name);
      if (!completeness.complete) {
        fail(
          "complete-guard",
          `mate: ${options.name} is not complete (${completeness.remaining} of ${completeness.total} tasks remaining). Use --force to override.`,
        );
        return result;
      }
    }
  }

  const preFinishHead = await git.headRef();

  // Never reset the whole companion: unrelated staged, unstaged, and untracked work
  // belongs to the developer. Restore only paths returned by the finisher, and only for
  // a FAILED produce with partial output. A successful produce may have MOVED data that
  // exists nowhere else (an active change dir that was never committed), so post-produce
  // failures must retain the produced paths — they are the resume state, not garbage.
  const rollback = async (paths: string[] | undefined): Promise<void> => {
    if (resuming || !paths || paths.length === 0) return;
    try {
      await git.restorePaths(preFinishHead, paths);
    } catch {
      // Best-effort; the failing-step message already surfaced the root cause.
    }
  };

  // Produce (skipped when resuming).
  let produced: Produced;
  if (resuming) {
    produced = existing!;
  } else {
    result.step = "produce";
    const outcome = await finisher.produce(options.name);
    if (!outcome.ok || !outcome.produced) {
      await rollback(outcome.produced?.commitPaths);
      fail(
        "produce",
        `mate: ${finisher.type} produce failed: ${outcome.message}${
          outcome.produced
            ? " Produced paths were restored."
            : " Any partial output was retained for inspection."
        }`,
      );
      return result;
    }
    produced = outcome.produced;
  }
  result.anchorName = produced.anchorName;
  const tagName = `${finisher.type}/${produced.anchorName}`;
  result.tag = tagName;

  // Capability sync (only openspec-derived outputs are refreshed; commit stays scoped).
  if (finisher.capSync) {
    result.step = "cap-sync";
    if (!(await finisher.capSync())) {
      // Post-produce failure: retain the produced artifact — it is the resume state.
      fail(
        "cap-sync",
        "mate: cap sync failed; the produced artifact was retained — re-run `mate artifact finish` to resume.",
      );
      return result;
    }
  }

  // Commit — stage only the finisher's scoped paths. When resuming a prior finish that
  // already committed, there is nothing to stage; treat that as the commit existing.
  result.step = "commit";
  try {
    await git.add(produced.commitPaths);
    if (await git.hasStagedChanges(produced.commitPaths)) {
      await git.commit(
        `chore(${finisher.type}): finish ${produced.anchorName}`,
        produced.commitPaths,
      );
    }
  } catch (err) {
    // Post-produce failure: retain the produced artifact — it is the resume state.
    fail(
      "commit",
      `mate: commit failed: ${String(err)}; the produced artifact was retained — re-run \`mate artifact finish\` to resume.`,
    );
    return result;
  }
  result.local.committed = true;

  // Sync with remote before tagging (skipped with --no-push — no remote target).
  if (!options.noPush) {
    result.step = "sync-remote";
    if (await git.hasUpstream()) {
      try {
        await git.fetch();
      } catch (err) {
        // Post-commit failure: retain the commit, do not roll back.
        fail("sync-remote", `mate: fetch failed: ${String(err)}`);
        return result;
      }
      const rebase = await git.rebaseOntoUpstream();
      if (!rebase.ok) {
        // Deliberate stop-for-handoff: commit exists, no tag, not pushed. Never auto-resolve.
        result.step = "sync-remote";
        result.status = "conflict";
        result.conflictedPaths = rebase.conflictedPaths;
        result.message =
          "mate: rebase onto remote conflicted; resolve the conflict, complete the rebase, then finish tag + push.";
        emit();
        process.exitCode = 1;
        return result;
      }
    }
  }

  // Tag the (rebased) finish commit — idempotent if a prior finish already tagged it.
  result.step = "tag";
  try {
    if (!(await git.tagExists(tagName))) {
      await git.tag(tagName, `Finish ${produced.anchorName}`);
    }
  } catch (err) {
    // Post-commit failure: retain the commit, do not roll back.
    fail("tag", `mate: tag failed: ${String(err)}`);
    return result;
  }
  result.local.tagged = true;

  if (options.noPush) {
    result.step = "done";
    result.status = "skipped";
    result.message = `Finished ${produced.anchorName} locally (commit + tag ${tagName}); not pushed (--no-push).`;
    emit();
    return result;
  }

  // Push branch + tag together.
  result.step = "push";
  const push = await git.push();
  if (!push.ok) {
    // Post-tag push failure: retain commit + tag for retry, do not roll back.
    result.status = "error";
    result.message = `mate: push failed (commit and tag ${tagName} retained locally): ${push.error}`;
    emit();
    process.exitCode = 1;
    return result;
  }
  result.local.pushed = true;

  result.step = "done";
  result.status = "ok";
  result.message = `Finished ${produced.anchorName}: ${resuming ? "resumed, " : ""}committed, tagged ${tagName}, and pushed.`;
  emit();
  return result;
}
