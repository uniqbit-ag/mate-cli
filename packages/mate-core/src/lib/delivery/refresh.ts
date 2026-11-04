import type { ForgeAdapter, ForgeFailure, ForgeRepo, PullCandidate } from "./forge";
import type { FetchResult, MergeGit, PatchMatch } from "./merge-git";
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
  | "direct"
  /** Local Git matched the changes on the default branch by patch identity only. */
  | "likely-merged"
  /** Local Git found the head nowhere on the default branch, as of the last fetch. */
  | "not-on-default";

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
  /** `likely-merged`: the default-branch commit carrying the delivery's changes. */
  suggestion?: PatchMatch;
  /** When the checkout last fetched `origin` (ISO 8601); null when unknown. Local checks only. */
  fetchedAt?: string | null;
  /** The fetch before a local check, when one ran. */
  fetch?: FetchResult;
}

export type ForgeAccess =
  | { adapter: ForgeAdapter; repo: ForgeRepo }
  | { unavailable: "no-token" | "unsupported-host" };

/** A local checkout of a repository, for merge checks the forge did not settle. */
export interface LocalMergeAccess {
  git: MergeGit;
  defaultBranch: string;
  /** Fetches the default branch and `branch`, at most once per branch. */
  fetch(branch: string): Promise<FetchResult>;
}

/** The clock, forge, and local Git a refresh reads. */
export interface RefreshAccess {
  now: () => Date;
  forgeAccess: (repository: string) => Promise<ForgeAccess>;
  /** The repository's local checkout, or null without one. */
  localAccess?: (repository: string) => Promise<LocalMergeAccess | null>;
  /** Fetch before a local check: the companion's Git mode is `auto`, or `--fetch` was passed. */
  fetch?: boolean;
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
 * Asks the forge, then a local checkout, about every branch delivery of a record (or the
 * one repository named) and records each definite answer with its source (`forge` or
 * `git`) and the branch head Git resolved. A direct delivery is never settled here: it
 * always needs the user's answer. Nothing is recorded for an ambiguous, suggested,
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
    const key = JSON.stringify([repository, branch, prNumber ?? null, direct, delivery.head]);

    let outcome = cache.get(key);
    if (!outcome) {
      outcome = await lookup(repository, branch, direct, prNumber, delivery.head, options);
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
        source: outcome.source ?? "forge",
        checkedAt: options.now().toISOString(),
        ...outcome.provenance,
      };
      next = upsertDelivery(next, repository, { merge, ...(outcome.pr ? { pr: outcome.pr } : {}) });
    }
    if (outcome.head && outcome.head !== delivery.head) {
      next = upsertDelivery(next, repository, { head: outcome.head });
    }
  }
  return { record: next, outcomes: outcomes.map(publicOutcome) };
}

/** Lookups by repository, branch, and PR number. */
export type RefreshCache = Map<string, LookupOutcome>;

interface LookupOutcome extends BranchOutcome {
  provenance?: MergeProvenance;
  source?: "forge" | "git";
  /** The branch tip Git resolved, recorded as the delivery's `head`. */
  head?: string;
}

function publicOutcome(outcome: LookupOutcome): BranchOutcome {
  const { provenance: _provenance, source: _source, head: _head, ...rest } = outcome;
  return rest;
}

async function lookup(
  repository: string,
  branch: string,
  direct: boolean,
  prNumber: number | undefined,
  recordedHead: string | undefined,
  options: RefreshOptions,
): Promise<LookupOutcome> {
  if (direct) {
    // Git cannot tell this change's commits from the user's other pushes, so the user decides.
    return { repository, branch, result: "unknown", needsAnswer: true, answerReason: "direct" };
  }
  const forge = await forgeLookup(repository, branch, prNumber, options);
  const local = await options.localAccess?.(repository);
  if (!local) return forge;
  // The forge's answer is final, and an ambiguous PR is the user's choice; Git only adds the head.
  if (!forge.needsAnswer || forge.answerReason === "ambiguous") {
    const head = await local.git.tip(branch);
    return head ? { ...forge, head } : forge;
  }
  const checked = await localLookup(local, repository, branch, recordedHead, options);
  return forge.failure ? { ...checked, failure: forge.failure } : checked;
}

/** The answer of a local checkout: merged by ancestry, a patch-identity suggestion, or none. */
async function localLookup(
  local: LocalMergeAccess,
  repository: string,
  branch: string,
  recordedHead: string | undefined,
  options: RefreshOptions,
): Promise<LookupOutcome> {
  const base = { repository, branch };
  const fetch = options.fetch ? await local.fetch(branch) : undefined;
  const withFetch = fetch ? { fetch } : {};
  const live = await local.git.tip(branch);
  const head =
    live ?? (recordedHead && (await local.git.hasCommit(recordedHead)) ? recordedHead : null);
  const onDefault = head !== null && (await local.git.isAncestor(head, local.defaultBranch));
  // A fast-forward and a branch without commits of its own look the same: only a merge
  // commit settles by itself.
  if (onDefault && !(await local.git.onFirstParent(head, local.defaultBranch))) {
    return { ...base, ...withFetch, result: "merged", needsAnswer: false, source: "git", head };
  }
  const suggestion = await suggestionFor(local, head, onDefault);
  const fetchedAt = await local.git.lastFetchedAt();
  return {
    ...base,
    ...withFetch,
    result: "unknown",
    needsAnswer: true,
    answerReason: suggestion ? "likely-merged" : "not-on-default",
    ...(suggestion ? { suggestion } : {}),
    fetchedAt,
    ...(live ? { head: live } : {}),
  };
}

/** What local Git can only suggest: a head on the default branch's own line, else a patch match. */
async function suggestionFor(
  local: LocalMergeAccess,
  head: string | null,
  onDefault: boolean,
): Promise<PatchMatch | null> {
  if (!head) return null;
  if (onDefault) return { commit: head, style: "fast-forward" };
  return local.git.patchMatch(head, local.defaultBranch);
}

async function forgeLookup(
  repository: string,
  branch: string,
  prNumber: number | undefined,
  options: RefreshOptions,
): Promise<LookupOutcome> {
  const base = { repository, branch };
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
