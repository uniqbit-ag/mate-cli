import type { WorksetRecord } from "../../workset/record";

/**
 * The factory work queue's one ordering rule: started Outcomes run in the order they were
 * started. A Later Outcome has no rank.
 */
export function rankOf(record: Pick<WorksetRecord, "queuedAt">): number | null {
  if (!record.queuedAt) return null;
  const queued = Date.parse(record.queuedAt);
  return Number.isNaN(queued) ? null : queued;
}

export interface Ranked {
  id: string;
  /** `null` for a Later Outcome: after every started entry, in the order given. */
  rank: number | null;
}

/** Lower rank first, then identifier; Later Outcomes keep their relative order at the end. */
export function compareRanked(a: Ranked, b: Ranked): number {
  if (a.rank === null || b.rank === null) {
    if (a.rank === b.rank) return 0;
    return a.rank === null ? 1 : -1;
  }
  return a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
