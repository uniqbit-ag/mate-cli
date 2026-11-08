import path from "node:path";

import { repositoryForPath, type UsageScope } from "./scope";
import type { UsageCost, UsageSourceName, UsageWindow } from "./types";
import { inUsageWindow } from "./window";

export interface UsageObservation {
  key: string;
  source: UsageSourceName;
  directory: string;
  /** Provider/Mate metadata takes precedence over a projected launch directory. */
  workingDirectory?: string;
  timestamp: string;
  model: string;
  tokens?: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
  };
  cost?: UsageCost;
  savings?: { tokens: number | null; calls: number | null; cost?: UsageCost };
}

export interface UsageRecord extends UsageObservation {
  repositoryId: string;
}

const tokenCount = (entry: UsageObservation) =>
  Object.values(entry.tokens ?? {}).reduce<number>((sum, value) => sum + (value ?? 0), 0);

/** More tokens win; on a tie, a priced record wins, and reported cost beats estimated. */
function supersedes(observation: UsageObservation, previous: UsageObservation): boolean {
  const count = tokenCount(observation);
  const previousCount = tokenCount(previous);
  if (count !== previousCount) return count > previousCount;
  if (!observation.cost) return false;
  if (!previous.cost) return true;
  return observation.cost.basis === "reported" && previous.cost.basis === "estimated";
}

export function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Conflicting duplicates are excluded, not assigned to whichever source was read first. */
export function normalizeUsageRecords(
  scope: UsageScope,
  window: UsageWindow,
  observations: readonly UsageObservation[],
): { records: UsageRecord[]; unattributed: Set<UsageSourceName> } {
  const records = new Map<string, UsageRecord>();
  const conflicts = new Set<string>();
  const unattributed = new Set<UsageSourceName>();
  for (const observation of observations) {
    if (!inUsageWindow(observation.timestamp, window)) continue;
    const repository = repositoryForPath(
      scope,
      observation.workingDirectory ?? observation.directory,
    );
    if (!repository || !observation.key) {
      // Unrelated absolute paths are outside scope; opaque project labels cannot prove attribution.
      if (!path.isAbsolute(observation.directory) || observation.workingDirectory)
        unattributed.add(observation.source);
      continue;
    }
    const key = `${observation.source}:${observation.key}`;
    const previous = records.get(key);
    if (conflicts.has(key)) continue;
    if (previous && previous.repositoryId !== repository.id) {
      records.delete(key);
      conflicts.add(key);
      unattributed.add(observation.source);
      continue;
    }
    if (!previous || supersedes(observation, previous))
      records.set(key, { ...observation, repositoryId: repository.id });
  }
  return { records: [...records.values()], unattributed };
}
