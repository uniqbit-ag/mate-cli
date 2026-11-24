import type { DeliveryEnvironment } from "../environment";
import { findDelivery, type Delivery, type DeliveryPatch, type DeliveryRecord } from "../record";
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
  /** Once aborted, no further check starts. */
  signal?: AbortSignal;
  /**
   * Called for each delivery left unchecked. Without it a failed check throws, and deliveries
   * skipped after an abort go unreported.
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
  const access = repositoryAccessFor(environment, deps);
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
      // oxlint-disable-next-line no-await-in-loop -- one registry read, then cached
      if (!(await isLinked(delivery.repository))) continue;
      const check = {
        index: checks.length,
        change: change.name,
        record,
        repository: delivery.repository,
        branch: delivery.branch,
      };
      checks.push(check);
      const key = delivery.repository.toLowerCase();
      queues.set(key, [...(queues.get(key) ?? []), check]);
    }
  }

  const cache: RefreshCache = new Map();
  const merges: (FoundMerge | null)[] = checks.map(() => null);
  const unchecked = ({ change, repository, branch }: Check, error?: unknown) =>
    deps.onUnchecked?.({ change, repository, branch, ...(error === undefined ? {} : { error }) });
  await Promise.all(
    [...queues.values()].map(async (queue) => {
      for (const check of queue) {
        if (deps.signal?.aborted) {
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
          if (!deps.onUnchecked) throw error;
          unchecked(check, error ?? new Error("merge check failed"));
          continue;
        }
        const after = findDelivery(refreshed.record, repository);
        if (after?.merge?.state !== "merged" || !after.branch) continue;
        merges[index] = {
          repository: after.repository,
          branch: after.branch,
          patch: {
            merge: after.merge,
            ...(after.head ? { head: after.head } : {}),
            ...(after.pr ? { pr: after.pr } : {}),
          },
        };
      }
    }),
  );

  const found = new Map<string, FoundMerge[]>();
  for (const check of checks) {
    const merge = merges[check.index];
    if (merge) found.set(check.change, [...(found.get(check.change) ?? []), merge]);
  }
  return found;
}
