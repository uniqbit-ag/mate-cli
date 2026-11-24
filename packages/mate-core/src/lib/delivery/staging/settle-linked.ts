import path from "node:path";

import { hasOpenspecCapability } from "../../orchestrator/capabilities";
import { companionContext } from "../../orchestrator/framework-context";
import {
  companionGit,
  describeGitFailure,
  type CompanionGit,
} from "../../../runtime/companion-git";
import { errorMessage } from "../../../runtime/error-message";
import type { PublicationSecretScan } from "../../../runtime/publication-secret-scan";
import { linkedDeliveryEnvironment, type DeliveryEnvironment } from "../environment";
import {
  findDelivery,
  readDeliveryRecord,
  upsertDelivery,
  writeDeliveryRecord,
  type Delivery,
  type DeliveryPatch,
  type DeliveryRecord,
} from "../record";
import { isSettled, refreshRecord, type RefreshCache } from "../refresh";
import { repositoryAccessFor, type RepositoryAccessDeps } from "../repository-access";
import { sourceDir, type ArtifactType } from "./artifact-type";
import { commitToPending } from "./pending-edit";
import { sourcePathOf, submittedAt } from "./pending";
import {
  fetchPendingBranches,
  pendingPlace,
  pendingRef,
  stagingRemote,
  type StagingRemote,
} from "./refs";
import { defaultArtifactType } from "./registry";

/** Bound on the pending-branch fetches and the push; the merge checks have their own. */
const SETTLE_BUDGET_MS = 60_000;

export interface SettleLinkedDeps extends RepositoryAccessDeps {
  git?: (cwd: string) => CompanionGit;
  artifactType?: ArtifactType;
  /** Scans the records a merge is written into; the publication scan by default. */
  scan?: (root: string, paths: string[], policyPath: string) => Promise<PublicationSecretScan>;
  now?: () => Date;
  newTransaction?: () => string;
  tmpRoot?: string;
  /** Once aborted, no further check runs and nothing is pushed. */
  signal?: AbortSignal;
  /** Asked right before each commit and push; false ends the run without one. */
  claimPush?: () => boolean;
}

export interface SettleLinkedResult {
  /** Changes whose Delivery Record on the pending branch gained a Git merge in this run. */
  recorded: string[];
  /** Why settling or recording failed; null when nothing failed. */
  warning: string | null;
}

/** A merge found for one delivery, applied to the record as the pending branch holds it. */
interface FoundMerge {
  repository: string;
  branch: string;
  patch: DeliveryPatch;
}

const defaultGit = (cwd: string): CompanionGit =>
  companionGit(cwd, { prompt: "never", budgetMs: SETTLE_BUDGET_MS });

/**
 * {@link settleLinked} for a companion `mate companion sync` resolved, with the Working
 * Repository at `repoPath` and the checkouts its registry links. Runs nothing without the
 * openspec capability or a readable companion configuration.
 */
export async function settleLinkedAt(
  companionPath: string,
  repoPath: string | undefined,
  options: SettleLinkedDeps = {},
): Promise<SettleLinkedResult> {
  const context = companionContext(
    companionPath,
    repoPath ? { id: path.basename(repoPath), path: repoPath } : undefined,
  );
  const config = await context.configStore.load().catch(() => null);
  const capabilities = config?.capabilities ?? [];
  if (!hasOpenspecCapability(capabilities)) return { recorded: [], warning: null };
  try {
    return await settleLinked(
      await linkedDeliveryEnvironment(context, capabilities, repoPath),
      options,
    );
  } catch (error) {
    return failed(error);
  }
}

function failed(error: unknown): SettleLinkedResult {
  return { recorded: [], warning: `settling merges failed: ${errorMessage(error)}` };
}

/** A delivery a linked checkout may settle: a branch, not direct, not merged or dropped yet. */
function settleable(delivery: Delivery): delivery is Delivery & { branch: string } {
  return (
    delivery.notApplicable === undefined &&
    Boolean(delivery.branch) &&
    !delivery.direct &&
    !isSettled(delivery)
  );
}

/**
 * Settles the deliveries of submitted changes whose repositories are linked on this machine and
 * records each newly found Git merge in the change's Delivery Record on the pending branch: one
 * commit for all of them, pushed without force and rebuilt on a moved tip. Nothing is pushed
 * when no merge was found. Only checkouts the environment links are inspected; a record naming
 * any other repository is skipped. Never throws: a failure is the result's warning.
 */
export async function settleLinked(
  environment: DeliveryEnvironment,
  deps: SettleLinkedDeps = {},
): Promise<SettleLinkedResult> {
  try {
    return await settle(environment, deps);
  } catch (error) {
    return failed(error);
  }
}

async function settle(
  environment: DeliveryEnvironment,
  deps: SettleLinkedDeps,
): Promise<SettleLinkedResult> {
  const gitFor = deps.git ?? defaultGit;
  const git = gitFor(environment.companionPath);
  const configured = await stagingRemote(git);
  if (!configured) return { recorded: [], warning: null };
  const fetched = await fetchPendingBranches(git, configured);
  if ("error" in fetched) return { recorded: [], warning: `settling merges: ${fetched.error}` };
  const type = deps.artifactType ?? environment.artifactType ?? defaultArtifactType();

  const found = await findMerges(environment, git, fetched, type, deps);
  if (found.size === 0 || deps.signal?.aborted) return { recorded: [], warning: null };

  const recorded: string[] = [];
  const result = await commitToPending(
    {
      companionPath: environment.companionPath,
      subject: `chore(${type.name}): record merges of ${[...found.keys()].join(", ")}`,
      edit: async (dir) => {
        recorded.length = 0;
        if (deps.signal?.aborted) return [];
        const paths: string[] = [];
        for (const [name, merges] of found) {
          const folder = sourceDir(dir, type, name);
          // oxlint-disable-next-line no-await-in-loop -- a handful of changes
          let record = await readDeliveryRecord(folder).catch(() => null);
          // Dropped, published, or resubmitted since: the record there decides.
          if (record?.state !== "submitted") continue;
          let changed = false;
          for (const { repository, branch, patch } of merges) {
            const delivery = findDelivery(record, repository);
            if (!delivery || delivery.branch !== branch || !settleable(delivery)) continue;
            record = upsertDelivery(record, repository, patch);
            changed = true;
          }
          if (!changed) continue;
          // oxlint-disable-next-line no-await-in-loop -- same change
          await writeDeliveryRecord(folder, record);
          paths.push(sourcePathOf(type, name));
          recorded.push(name);
        }
        return paths;
      },
      // The last moment to stop: once claimed, the commit and push run to their end.
      beforeCommit: () => !deps.signal?.aborted && deps.claimPush?.() !== false,
    },
    { ...deps, git: gitFor, artifactType: type },
  );

  if (result.status === "pushed") return { recorded: [...recorded], warning: null };
  if (result.status !== "failed") return { recorded: [], warning: null };
  switch (result.reason) {
    case "no-remote":
      return { recorded: [], warning: null };
    case "fetch-failed":
      return { recorded: [], warning: `recording merges: ${result.detail}` };
    case "secret": {
      const secrets = result.secretFindings.map((finding) => `${finding.path} (${finding.ruleId})`);
      return {
        recorded: [],
        warning: `recording merges on ${pendingPlace(result.remote)} was refused: secrets at ${[...new Set(secrets)].join(", ")}; the next settlement tries again.`,
      };
    }
    default:
      return { recorded: [], warning: recordFailure(result.remote, result.git) };
  }
}

function recordFailure(remote: StagingRemote, result: Parameters<typeof describeGitFailure>[0]) {
  return `recording merges on ${pendingPlace(remote)} failed; the next settlement tries again. ${describeGitFailure(result)}`;
}

/** One linked delivery to check, numbered in submit order. */
interface Check {
  index: number;
  change: string;
  record: DeliveryRecord;
  repository: string;
}

/**
 * Merges Git proves for linked deliveries of the submitted changes, by change name in submit
 * order. Repositories are checked side by side; one repository's checks run in turn, since
 * concurrent fetches into one checkout contend for its refs.
 */
async function findMerges(
  environment: DeliveryEnvironment,
  git: CompanionGit,
  remote: StagingRemote,
  type: ArtifactType,
  deps: SettleLinkedDeps,
): Promise<Map<string, FoundMerge[]>> {
  const submitted = await submittedAt(git, pendingRef(remote), type, deps.tmpRoot);
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
      };
      checks.push(check);
      const key = delivery.repository.toLowerCase();
      queues.set(key, [...(queues.get(key) ?? []), check]);
    }
  }

  const cache: RefreshCache = new Map();
  const merges: (FoundMerge | null)[] = checks.map(() => null);
  await Promise.all(
    [...queues.values()].map(async (queue) => {
      for (const { index, record, repository } of queue) {
        if (deps.signal?.aborted) return;
        // oxlint-disable-next-line no-await-in-loop -- shared branches are checked once
        const refreshed = await refreshRecord(record, {
          now: deps.now ?? (() => new Date()),
          localAccess: async (repo) => (await access(repo).local?.()) ?? null,
          fetch: environment.gitAutoMode === true,
          repository,
          cache,
        });
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
