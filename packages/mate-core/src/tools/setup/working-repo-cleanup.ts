import { unproject } from "../../lib/orchestrator/working-repo-projection";
import type { ProjectionEntryId } from "../../lib/orchestrator/projection-types";

export interface WorkingRepoCleanupResult {
  changed: boolean;
  removed: string[];
  updated: string[];
  /** Entries `unproject` deliberately left in place, named rather than omitted. */
  retained: string[];
}

/**
 * How an entry is reported. Presentation only — cleanup holds no list of paths,
 * so a newly declared entry is removed without touching this map.
 */
const REPORTED_AS: Partial<
  Record<ProjectionEntryId, { as: "removed" | "updated"; label: string }>
> = {
  "projection-root": { as: "removed", label: ".mate" },
  "git-excludes": { as: "removed", label: "git-excludes" },
  "claude-working-settings": { as: "updated", label: "claude-settings" },
  "legacy-tokensave-claude-md": { as: "updated", label: "claude-settings" },
};

export async function cleanupWorkingRepository(
  repoPath: string,
  registeredCompanionPaths: string[] = [],
): Promise<WorkingRepoCleanupResult> {
  const { outcomes } = await unproject({ repoPath, registeredCompanionPaths });
  const removed: string[] = [];
  const updated: string[] = [];
  const retained: string[] = [];

  for (const entry of outcomes) {
    if (entry.state === "retained") {
      retained.push(entry.id);
      continue;
    }
    if (entry.state !== "removed") continue;
    const reported = REPORTED_AS[entry.id];
    if (!reported) continue;
    const bucket = reported.as === "removed" ? removed : updated;
    if (!bucket.includes(reported.label)) bucket.push(reported.label);
  }

  return { changed: removed.length > 0 || updated.length > 0, removed, updated, retained };
}
