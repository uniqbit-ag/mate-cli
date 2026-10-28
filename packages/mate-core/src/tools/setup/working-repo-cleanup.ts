import { unproject } from "../../lib/orchestrator/working-repo-projection";
import type { ProjectionEntryId } from "../../lib/orchestrator/projection-types";

export interface WorkingRepoCleanupResult {
  changed: boolean;
  removed: string[];
  updated: string[];
  /** Entries `unproject` deliberately left in place, named rather than omitted. */
  retained: string[];
  /** Shared exclude lines kept because another Checkout of the clone still needs them. */
  kept: Array<{ label: string; keptFor: string[] }>;
  /** What a removal warned about, such as files a kept line now hides here. */
  warnings: string[];
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
  "openspec-store-pointer": { as: "removed", label: "openspec/config.yaml" },
  "claude-working-settings": { as: "updated", label: "claude-settings" },
  "legacy-tokensave-claude-md": { as: "updated", label: "claude-settings" },
};

/** How a kept entry is named: the exclude lines it kept, not the entry. */
const KEPT_AS: Partial<Record<ProjectionEntryId, string>> = {
  "git-excludes": "git-excludes",
  "openspec-store-exclude": "openspec-exclude",
  "opencode-companion-copies": "opencode-copy-excludes",
};

export async function cleanupWorkingRepository(
  repoPath: string,
  registeredCompanionPaths: string[] = [],
): Promise<WorkingRepoCleanupResult> {
  const { outcomes } = await unproject({ repoPath, registeredCompanionPaths });
  const removed: string[] = [];
  const updated: string[] = [];
  const retained: string[] = [];
  const kept: WorkingRepoCleanupResult["kept"] = [];
  const warnings = outcomes.flatMap((entry) => entry.warnings ?? []);
  /** A kept entry that still removed some of its lines changed the file. */
  let partlyKept = false;

  for (const entry of outcomes) {
    /** Named once, as kept, even where it removed some of its lines. */
    if (entry.keptFor) {
      kept.push({ label: KEPT_AS[entry.id] ?? entry.id, keptFor: entry.keptFor });
      if (entry.state === "removed") partlyKept = true;
      continue;
    }
    if (entry.state === "retained") {
      retained.push(entry.id);
      continue;
    }
    if (entry.retains && !retained.includes(entry.retains)) retained.push(entry.retains);
    if (entry.state !== "removed") continue;
    const reported = REPORTED_AS[entry.id];
    if (!reported) continue;
    const bucket = reported.as === "removed" ? removed : updated;
    if (!bucket.includes(reported.label)) bucket.push(reported.label);
  }

  return {
    changed: removed.length > 0 || updated.length > 0 || partlyKept,
    removed,
    updated,
    retained,
    kept,
    warnings,
  };
}
