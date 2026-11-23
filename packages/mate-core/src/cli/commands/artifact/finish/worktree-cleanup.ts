import { ARCHIVE_RELATIVE_DIR, changeNameOf } from "../../../../lib/change-layout";
import {
  DELIVERY_FILE,
  type DeliveryRecord,
  parseDeliveryRecord,
} from "../../../../lib/delivery/record";
import { readWorksets } from "../../../../lib/workset/record";
import {
  type GitRunner,
  type PruneResult,
  type PruneTarget,
  pruneWorksetWorktrees,
  runGit,
} from "../../../../lib/workset/worktree";
import { errorMessage } from "../../../../runtime/error-message";
import { readCompanionWorksetStages } from "../../studio/payload";

export interface WorktreeCleanupDeps {
  readWorksets?: typeof readWorksets;
  worksetStages?: typeof readCompanionWorksetStages;
  pruneWorktrees?: typeof pruneWorksetWorktrees;
  git?: GitRunner;
}

/** An archive a `status: "ok"` publication made, with the commit it landed in when known. */
export interface PublishedAnchor {
  anchor: string;
  commit?: string;
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
 * `published` are the archives of `status: "ok"` publications, in order. Returns each
 * Workset's outcome keyed by the anchor that completed it; never throws.
 */
export async function cleanUpCompletedWorksets(
  companionPath: string,
  published: readonly PublishedAnchor[],
  deps: WorktreeCleanupDeps = {},
): Promise<Map<string, PruneResult>> {
  const outcomes = new Map<string, PruneResult>();
  if (published.length === 0) return outcomes;
  let completed: { anchor: string; target: PruneTarget }[];
  try {
    completed = await completedWorksets(companionPath, published, deps);
  } catch (error) {
    outcomes.set(published.at(-1)!.anchor, failed(error));
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
  published: readonly PublishedAnchor[],
  deps: WorktreeCleanupDeps,
): Promise<{ anchor: string; target: PruneTarget }[]> {
  const { worksets } = await (deps.readWorksets ?? readWorksets)(companionPath);
  const records = await publishedRecords(companionPath, published, deps.git ?? runGit);
  const byWorkset = new Map<string, { anchor: string; target: PruneTarget; explicit: boolean }>();
  for (const { anchor } of published) {
    const name = changeNameOf(anchor);
    const record = worksets.find((entry) =>
      entry.changes.some((change) => changeNameOf(change) === name),
    );
    const delivery = records.get(anchor);
    byWorkset.set(
      record?.id ?? name,
      record
        ? { anchor, target: { id: record.id, changes: record.changes }, explicit: true }
        : {
            anchor,
            target: {
              id: name,
              changes: [anchor],
              ...(delivery ? { records: new Map([[anchor, delivery]]) } : {}),
            },
            explicit: false,
          },
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

/**
 * The Delivery Records the publications archived, by anchor, read from the commits they
 * landed in: a Delivery Group published to the remote may be missing from this checkout.
 * An anchor whose record cannot be read there is left to the checkout's lookup.
 */
async function publishedRecords(
  companionPath: string,
  published: readonly PublishedAnchor[],
  git: GitRunner,
): Promise<Map<string, DeliveryRecord>> {
  const records = new Map<string, DeliveryRecord>();
  for (const { anchor, commit } of published) {
    if (!commit) continue;
    const file = `${ARCHIVE_RELATIVE_DIR}/${anchor}/${DELIVERY_FILE}`;
    // oxlint-disable-next-line no-await-in-loop -- a few small blobs, in order
    const shown = await git(companionPath, ["show", `${commit}:${file}`]);
    if (shown.code !== 0) continue;
    try {
      records.set(anchor, parseDeliveryRecord(shown.stdout, `${commit}:${file}`, anchor));
    } catch {
      // A record it cannot parse is read again, and reported, from the checkout.
    }
  }
  return records;
}
