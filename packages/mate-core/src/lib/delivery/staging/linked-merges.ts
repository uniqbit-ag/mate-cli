import type { DeliveryEnvironment } from "../environment";
import {
  findDelivery,
  sameRepository,
  type Delivery,
  type DeliveryPatch,
  type DeliveryRecord,
} from "../record";
import { isSettled, refreshRecord, type RefreshCache } from "../refresh";
import { repositoryAccessFor, type RepositoryAccessDeps } from "../repository-access";

/** A merge Git proved for one delivery, as a patch to the record's delivery. */
export interface FoundMerge {
  repository: string;
  branch: string;
  patch: DeliveryPatch;
}

/** A linked delivery left unchecked: the signal aborted before its turn, or its check threw. */
export interface UncheckedDelivery {
  change: string;
  repository: string;
  branch: string;
  /** Why its check failed; absent when it never started. */
  error?: unknown;
}

export interface FindLinkedMergesDeps extends RepositoryAccessDeps {
  now?: () => Date;
  /** Once aborted, no further check starts and running checks' Git commands are killed. */
  signal?: AbortSignal;
  /**
   * Called for each delivery left unchecked, including one whose fetch failed and that Git found
   * unmerged. Without it the first failed check stops the others and then throws, and skipped
   * deliveries go unreported.
   */
  onUnchecked?: (delivery: UncheckedDelivery) => void;
}

/** A delivery a linked checkout may settle: a branch, not direct, not merged or dropped yet. */
export function settleable(delivery: Delivery): delivery is Delivery & { branch: string } {
  return (
    delivery.notApplicable === undefined &&
    Boolean(delivery.branch) &&
    !delivery.direct &&
    !isSettled(delivery)
  );
}

/** One linked delivery to check, numbered in submit order. */
interface Check {
  index: number;
  change: string;
  record: DeliveryRecord;
  repository: string;
  branch: string;
}

/**
 * Merges Git proves for linked deliveries of `submitted`, by change name in submit order. Only
 * checkouts the environment links are inspected; nothing is recorded. Repositories are checked
 * side by side; one repository's checks run in turn, since concurrent fetches into one checkout
 * contend for its refs.
 */
export async function findLinkedMerges(
  environment: DeliveryEnvironment,
  submitted: readonly { name: string; delivery: { record: DeliveryRecord | null } }[],
  deps: FindLinkedMergesDeps = {},
): Promise<Map<string, FoundMerge[]>> {
  const stop = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, stop.signal]) : stop.signal;
  const access = repositoryAccessFor(environment, { openCheckout: deps.openCheckout, signal });
  const unchecked = (
    { change, repository, branch }: Omit<UncheckedDelivery, "error">,
    error?: unknown,
  ) =>
    deps.onUnchecked?.({ change, repository, branch, ...(error === undefined ? {} : { error }) });
  const linked = new Map<string, Promise<boolean>>();
  const isLinked = (repository: string): Promise<boolean> => {
    const key = repository.toLowerCase();
    let known = linked.get(key);
    if (!known) {
      known = (environment.checkoutOf?.(repository) ?? Promise.resolve(null)).then(Boolean);
      linked.set(key, known);
    }
    return known;
  };
  const checks: Check[] = [];
  const queues = new Map<string, Check[]>();
  for (const change of submitted) {
    const record = change.delivery.record;
    if (!record) continue;
    for (const delivery of record.deliveries.filter(settleable)) {
      const { repository, branch } = delivery;
      let isLinkedHere: boolean;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one registry read, then cached
        isLinkedHere = await isLinked(repository);
      } catch (error) {
        if (!deps.onUnchecked) throw error;
        unchecked({ change: change.name, repository, branch }, error);
        continue;
      }
      if (!isLinkedHere) continue;
      const check = { index: checks.length, change: change.name, record, repository, branch };
      checks.push(check);
      const key = repository.toLowerCase();
      queues.set(key, [...(queues.get(key) ?? []), check]);
    }
  }

  const cache: RefreshCache = new Map();
  const merges: (FoundMerge | null)[] = checks.map(() => null);
  let failure: { error: unknown } | undefined;
  await Promise.all(
    [...queues.values()].map(async (queue) => {
      for (const check of queue) {
        if (signal.aborted) {
          unchecked(check);
          continue;
        }
        const { index, record, repository } = check;
        let refreshed: Awaited<ReturnType<typeof refreshRecord>>;
        try {
          // oxlint-disable-next-line no-await-in-loop -- shared branches are checked once
          refreshed = await refreshRecord(record, {
            now: deps.now ?? (() => new Date()),
            localAccess: async (repo) => (await access(repo).local?.()) ?? null,
            fetch: environment.gitAutoMode === true,
            repository,
            cache,
          });
        } catch (error) {
          if (deps.onUnchecked) {
            unchecked(check, error ?? new Error("merge check failed"));
          } else {
            failure ??= { error };
            stop.abort();
          }
          continue;
        }
        const after = findDelivery(refreshed.record, repository);
        if (after?.merge?.state === "merged" && after.branch) {
          merges[index] = {
            repository: after.repository,
            branch: after.branch,
            patch: {
              merge: after.merge,
              ...(after.head ? { head: after.head } : {}),
              ...(after.pr ? { pr: after.pr } : {}),
            },
          };
          continue;
        }
        // Killed mid-check, or answered from refs a failed fetch left stale: no answer.
        if (signal.aborted) {
          unchecked(check);
          continue;
        }
        const fetch = refreshed.outcomes.find((outcome) =>
          sameRepository(outcome.repository, repository),
        )?.fetch;
        if (fetch?.ok === false) unchecked(check, new Error(fetch.message ?? "git fetch failed"));
      }
    }),
  );
  if (failure) throw failure.error;

  const found = new Map<string, FoundMerge[]>();
  for (const check of checks) {
    const merge = merges[check.index];
    if (merge) found.set(check.change, [...(found.get(check.change) ?? []), merge]);
  }
  return found;
}
