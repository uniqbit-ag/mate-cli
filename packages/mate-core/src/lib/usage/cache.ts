import { collectCompanionUsage } from "./collect";
import { resolveUsageScope, type UsageScope } from "./scope";
import {
  UsageError,
  type CompanionUsageSnapshot,
  type UsageResponse,
  type UsageWindow,
} from "./types";
import { usageWindow } from "./window";

export interface UsageRequest {
  days: number;
  refresh?: boolean;
}
export interface UsageCache {
  read(companionPath: string, request: UsageRequest): Promise<UsageResponse>;
}

/** Inserts as most recent and evicts the least recently used past the limit. */
function remember<T>(entries: Map<string, T>, key: string, value: T, limit: number): void {
  entries.delete(key);
  entries.set(key, value);
  while (entries.size > limit) entries.delete(entries.keys().next().value!);
}

export function createUsageCache(
  deps: {
    scope?: (path: string) => Promise<UsageScope>;
    collect?: (scope: UsageScope, window: UsageWindow) => Promise<CompanionUsageSnapshot>;
    now?: () => Date;
    limit?: number;
  } = {},
): UsageCache {
  const held = new Map<string, CompanionUsageSnapshot>();
  /** Last good snapshot per companion and window, whatever its scope; served when scope resolution fails. */
  const latest = new Map<string, CompanionUsageSnapshot>();
  const inFlight = new Map<string, Promise<UsageResponse>>();
  const limit = Math.max(1, deps.limit ?? 32);
  return {
    async read(companionPath, request) {
      const window = usageWindow(request.days, deps.now?.() ?? new Date());
      const period = JSON.stringify([companionPath, window.start, window.endExclusive]);
      let scope: UsageScope;
      try {
        scope = await (deps.scope ?? resolveUsageScope)(companionPath);
      } catch {
        return {
          snapshot: latest.get(period) ?? null,
          error: { code: "COMPANION_UNRESOLVED", message: "The selected companion is unavailable" },
        };
      }
      const key = JSON.stringify([
        companionPath,
        window.start,
        window.endExclusive,
        scope.fingerprint,
      ]);
      const cached = held.get(key);
      if (cached && !request.refresh) {
        remember(held, key, cached, limit);
        return { snapshot: cached, error: null };
      }
      const pending = inFlight.get(key);
      if (pending) return pending;
      const collect = Promise.resolve().then(async (): Promise<UsageResponse> => {
        try {
          const snapshot = await (deps.collect ?? collectCompanionUsage)(scope, window);
          remember(held, key, snapshot, limit);
          remember(latest, period, snapshot, limit);
          return { snapshot, error: null };
        } catch (error) {
          return {
            snapshot: cached ?? null,
            error: {
              code: error instanceof UsageError ? error.code : "COLLECTION_FAILED",
              message: "Usage refresh failed.",
            },
          };
        } finally {
          inFlight.delete(key);
        }
      });
      inFlight.set(key, collect);
      return collect;
    },
  };
}
