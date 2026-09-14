import type { ArtifactFinisher, Produced } from "./finisher";
import type { GitOps } from "./git";

/** Pipeline step a {@link FinishResult} refers to (generic across artifact kinds). */
export type FinishStep =
  | "resolve"
  | "branch-guard"
  | "cap-sync"
  | "commit"
  | "sync-remote"
  | "tag"
  | "push"
  | "done";

export type FinishStatus = "ok" | "conflict" | "error" | "skipped";

/**
 * Machine-readable result emitted with `--json`. The publish skill parses this to
 * decide whether to hand a rebase conflict to a human, or to drive the remaining
 * tag + push after resolving one.
 */
export interface FinishResult {
  type: string;
  name: string;
  anchorName: string | null;
  tag: string | null;
  /** True when a prior publication already committed or tagged this anchor. */
  resumed: boolean;
  step: FinishStep;
  status: FinishStatus;
  conflictedPaths: string[];
  local: { committed: boolean; tagged: boolean; pushed: boolean };
  message: string;
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
}

/**
 * Runs the fixed publication pipeline for a resolved {@link ArtifactFinisher}:
 * resolve → branch guard → cap sync → scoped commit → sync-remote → tag → push. The
 * git, remote-sync, and conflict-handoff machinery is identical for every artifact
 * kind — only the finisher's resolution and cap sync vary.
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
  const tagName = `${finisher.type}/${resolved.anchorName}`;
  result.tag = tagName;

  // Branch guard — before cap sync, so a refusal mutates nothing at all. It applies to
  // --no-push too: the local tag it creates is the anchor a later push would publish.
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

  // Commit — stage only the finisher's scoped paths. Nothing to stage means a prior
  // publication already committed this anchor, which is a resume rather than an error.
  result.step = "commit";
  try {
    await git.add(resolved.commitPaths);
    if (await git.hasStagedChanges(resolved.commitPaths)) {
      await git.commit(
        `chore(${finisher.type}): finish ${resolved.anchorName}`,
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

  // Tag the (rebased) publication commit — idempotent if a prior run already tagged it.
  result.step = "tag";
  try {
    if (await git.tagExists(tagName)) {
      result.resumed = true;
    } else {
      await git.tag(tagName, `Publish ${resolved.anchorName}`);
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
    result.message = `Published ${resolved.anchorName} locally (commit + tag ${tagName}); not pushed (--no-push).`;
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
  result.message = `Published ${resolved.anchorName}: ${result.resumed ? "resumed, " : ""}committed, tagged ${tagName}, and pushed.`;
  emit();
  return result;
}
