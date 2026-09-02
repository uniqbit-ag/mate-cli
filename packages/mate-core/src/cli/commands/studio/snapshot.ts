import { assembleCompanionPayload, type StudioCompanionResponse } from "./payload";

/** One companion's collected state, with the moment it was collected. */
export interface StudioSnapshot {
  response: StudioCompanionResponse;
  collectedAt: number;
}

export interface StudioSnapshotCache {
  read(companionPath: string, refresh: boolean): Promise<StudioSnapshot>;
}

export interface StudioSnapshotCacheDeps {
  assembleCompanionPayload?: (companionPath: string) => Promise<StudioCompanionResponse>;
  now?: () => number;
}

/**
 * Holds each Companion Repository's collected state for the life of the server
 * process. Collection costs one OpenSpec subprocess per command, so re-running
 * it for a view switch would charge the reader a second of process startup to
 * see the same state twice — and the page already promises that its data moves
 * only on load or on an explicit refresh. A refresh collects again and replaces
 * the snapshot; nothing else does.
 *
 * Concurrent reads of one companion share a single collection: a second request
 * arriving mid-collection awaits the first rather than spawning its own.
 */
export function createStudioSnapshotCache(deps: StudioSnapshotCacheDeps = {}): StudioSnapshotCache {
  const assemble = deps.assembleCompanionPayload ?? assembleCompanionPayload;
  const now = deps.now ?? Date.now;
  const snapshots = new Map<string, StudioSnapshot>();
  const inFlight = new Map<string, Promise<StudioSnapshot>>();

  const collect = (companionPath: string): Promise<StudioSnapshot> => {
    const startedAt = now();
    const pending = assemble(companionPath).then((response) => {
      const snapshot: StudioSnapshot = { response, collectedAt: startedAt };
      /** Two overlapping collections must not leave the older one's state behind. */
      const held = snapshots.get(companionPath);
      if (!held || held.collectedAt <= startedAt) snapshots.set(companionPath, snapshot);
      return snapshot;
    });

    /** A failed collection leaves no snapshot, so the next read collects again. */
    inFlight.set(companionPath, pending);
    return pending.finally(() => {
      if (inFlight.get(companionPath) === pending) inFlight.delete(companionPath);
    });
  };

  return {
    read(companionPath: string, refresh: boolean): Promise<StudioSnapshot> {
      if (!refresh) {
        const cached = snapshots.get(companionPath);
        if (cached) return Promise.resolve(cached);
        const pending = inFlight.get(companionPath);
        if (pending) return pending;
      }
      return collect(companionPath);
    },
  };
}
