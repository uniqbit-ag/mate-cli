import type { ForgeAdapter, ForgeFailure, ForgeRepo, PullCandidate } from "./forge";
import {
  pickProvenance,
  sameRepository,
  upsertDelivery,
  type DeliveryRecord,
  type MergeProvenance,
  type MergeState,
} from "./record";

/** Why a branch's merge state must come from the user instead of the forge. */
export type AnswerReason =
  | "no-token"
  | "unsupported-host"
  | "forge-failure"
  | "no-pr"
  | "ambiguous"
  | "direct";

export interface BranchOutcome {
  repository: string;
  branch: string;
  /** What is now known; `unknown` when the forge could not answer. */
  result: MergeState | "ambiguous" | "none" | "unknown";
  pr?: string;
  candidates?: PullCandidate[];
  failure?: ForgeFailure;
  /** True when the user has to answer merged, not yet merged, or dropped. */
  needsAnswer: boolean;
  answerReason?: AnswerReason;
}

export type ForgeAccess =
  | { adapter: ForgeAdapter; repo: ForgeRepo }
  | { unavailable: "no-token" | "unsupported-host" };

/** The clock, forge, and local Git a refresh reads. */
export interface RefreshAccess {
  now: () => Date;
  forgeAccess: (repository: string) => Promise<ForgeAccess>;
}

export interface RefreshOptions extends RefreshAccess {
  /** Restricts the refresh to one repository's delivery. */
  repository?: string;
  /** Shared across changes in one run, so a branch is asked about once. */
  cache?: RefreshCache;
}

/** The PR number in a `…/pull/<n>` URL. */
function prNumberFrom(url: string | undefined): number | undefined {
  const match = url ? /\/pull\/(\d+)/.exec(url) : null;
  return match ? Number(match[1]) : undefined;
}

/**
 * Asks the forge about every branch delivery of a record (or the one repository named)
 * and records each definite answer with source `forge`. A direct delivery is never settled
 * here: it always needs the user's answer. Nothing is recorded for an ambiguous,
 * missing, or failed lookup: those come back as outcomes needing an answer. A delivery the
 * user answered as merged or dropped is skipped.
 */
export async function refreshRecord(
  record: DeliveryRecord,
  options: RefreshOptions,
): Promise<{ record: DeliveryRecord; outcomes: BranchOutcome[] }> {
  let next = record;
  const outcomes: BranchOutcome[] = [];
  const cache: RefreshCache = options.cache ?? new Map();

  for (const delivery of record.deliveries) {
    if (delivery.notApplicable !== undefined || !delivery.branch) continue;
    if (options.repository && !sameRepository(delivery.repository, options.repository)) continue;
    // A user answer of merged or dropped stands; the forge may still settle a "not yet merged".
    if (delivery.merge?.source === "user" && delivery.merge.state !== "open") continue;
    const { repository, branch } = delivery;
    // A recorded PR URL picks that PR when several have the branch as head, unless it was dropped.
    const prNumber = prNumberFrom(delivery.pr);
    const direct = Boolean(delivery.direct);
    // A direct delivery is checked in Git, a PR delivery on the forge: never share an answer.
    const key = JSON.stringify([repository, branch, prNumber ?? null, direct]);

    let outcome = cache.get(key);
    if (!outcome) {
      outcome = await lookup(repository, branch, direct, prNumber, options);
      cache.set(key, outcome);
    }
    outcomes.push(outcome);

    if (
      outcome.result === "merged" ||
      outcome.result === "open" ||
      outcome.result === "closed-unmerged"
    ) {
      const merge = {
        state: outcome.result,
        source: "forge" as const,
        checkedAt: options.now().toISOString(),
        ...outcome.provenance,
      };
      next = upsertDelivery(next, repository, { merge, ...(outcome.pr ? { pr: outcome.pr } : {}) });
    }
  }
  return { record: next, outcomes: outcomes.map(publicOutcome) };
}

/** Lookups by repository, branch, and PR number. */
export type RefreshCache = Map<string, LookupOutcome>;

interface LookupOutcome extends BranchOutcome {
  provenance?: MergeProvenance;
}

function publicOutcome(outcome: LookupOutcome): BranchOutcome {
  const { provenance: _provenance, ...rest } = outcome;
  return rest;
}

async function lookup(
  repository: string,
  branch: string,
  direct: boolean,
  prNumber: number | undefined,
  options: RefreshOptions,
): Promise<LookupOutcome> {
  const base = { repository, branch };
  if (direct) {
    // Git cannot tell this change's commits from the user's other pushes, so the user decides.
    return { ...base, result: "unknown", needsAnswer: true, answerReason: "direct" };
  }
  const access = await options.forgeAccess(repository);
  if ("unavailable" in access) {
    return { ...base, result: "unknown", needsAnswer: true, answerReason: access.unavailable };
  }
  let answer = await access.adapter.pullsForBranch(access.repo, branch, prNumber);
  // A recorded PR that is closed or gone must not hide a newer PR from the same branch.
  if (
    prNumber !== undefined &&
    answer.ok &&
    (answer.value.kind === "none" || answer.value.kind === "closed-unmerged")
  ) {
    const wider = await access.adapter.pullsForBranch(access.repo, branch);
    if (wider.ok && wider.value.kind !== "none") answer = wider;
  }
  if (!answer.ok) {
    return {
      ...base,
      result: "unknown",
      failure: answer.failure,
      needsAnswer: true,
      answerReason: "forge-failure",
    };
  }
  const value = answer.value;
  if (value.kind === "none") {
    return { ...base, result: "none", needsAnswer: true, answerReason: "no-pr" };
  }
  if (value.kind === "ambiguous") {
    return {
      ...base,
      result: "ambiguous",
      candidates: value.candidates,
      needsAnswer: true,
      answerReason: "ambiguous",
    };
  }
  return {
    ...base,
    result: value.kind,
    pr: value.pr.url,
    needsAnswer: false,
    provenance: pickProvenance(value.pr),
  };
}
