import { changeNameOf } from "../../../../lib/change-layout";
import { readWorksets } from "../../../../lib/workset/record";
import {
  type PruneResult,
  type PruneTarget,
  pruneWorksetWorktrees,
} from "../../../../lib/workset/worktree";
import { errorMessage } from "../../../../runtime/error-message";
import { readCompanionWorksetStages } from "../../studio/payload";

export interface WorktreeCleanupDeps {
  readWorksets?: typeof readWorksets;
  worksetStages?: typeof readCompanionWorksetStages;
  pruneWorktrees?: typeof pruneWorksetWorktrees;
}

/** A cleanup that could not run, reported on the result instead of failing it. */
function failed(error: unknown): PruneResult {
  return {
    removed: [],
    kept: [],
    warnings: [`worktree cleanup failed: ${errorMessage(error)}`],
  };
}

/**
 * Removes the worktrees of every Workset the given publications made Done, best effort.
 * `published` are the anchors of `status: "ok"` publications, in order. Returns each
 * Workset's outcome keyed by the anchor that completed it; never throws.
 */
export async function cleanUpCompletedWorksets(
  companionPath: string,
  published: readonly string[],
  deps: WorktreeCleanupDeps = {},
): Promise<Map<string, PruneResult>> {
  const outcomes = new Map<string, PruneResult>();
  if (published.length === 0) return outcomes;
  let completed: { anchor: string; target: PruneTarget }[];
  try {
    completed = await completedWorksets(companionPath, published, deps);
  } catch (error) {
    outcomes.set(published.at(-1)!, failed(error));
    return outcomes;
  }
  const prune = deps.pruneWorktrees ?? pruneWorksetWorktrees;
  for (const { anchor, target } of completed) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Git operations on shared checkouts, one at a time
      outcomes.set(anchor, await prune(companionPath, [target]));
    } catch (error) {
      outcomes.set(anchor, failed(error));
    }
  }
  return outcomes;
}

/**
 * The Worksets that are Done after these publications, each with the last anchor of it
 * published. A change no record lists is an implicit single-change Workset, Done once
 * published; an explicit one is Done when its derived stage says so.
 */
async function completedWorksets(
  companionPath: string,
  published: readonly string[],
  deps: WorktreeCleanupDeps,
): Promise<{ anchor: string; target: PruneTarget }[]> {
  const { worksets } = await (deps.readWorksets ?? readWorksets)(companionPath);
  const byWorkset = new Map<string, { anchor: string; target: PruneTarget; explicit: boolean }>();
  for (const anchor of published) {
    const name = changeNameOf(anchor);
    const record = worksets.find((entry) =>
      entry.changes.some((change) => changeNameOf(change) === name),
    );
    byWorkset.set(
      record?.id ?? name,
      record
        ? { anchor, target: { id: record.id, changes: record.changes }, explicit: true }
        : { anchor, target: { id: name, changes: [anchor] }, explicit: false },
    );
  }
  const explicit = [...byWorkset.values()].some((entry) => entry.explicit);
  const done = explicit
    ? new Set(
        (await (deps.worksetStages ?? readCompanionWorksetStages)(companionPath)).worksets
          .filter((entry) => entry.derived.stage === "done")
          .map((entry) => entry.record.id),
      )
    : new Set<string>();
  return [...byWorkset.values()]
    .filter((entry) => !entry.explicit || done.has(entry.target.id))
    .map(({ anchor, target }) => ({ anchor, target }));
}
