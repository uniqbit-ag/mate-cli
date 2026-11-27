import type { FetchResult, MergeGit, PatchMatch, PullRef } from "./merge-git";
import {
  findDelivery,
  isCommitId,
  sameRepository,
  upsertDelivery,
  type Delivery,
  type DeliveryRecord,
  type MergeProvenance,
  type MergeState,
} from "./record";
import { pullRequestOf, pullRequestUrl, type RemoteRepo } from "./remote";

/** Why a branch's merge state must come from the user instead of Git. */
export type AnswerReason =
  | "direct"
  /** Git matched the changes on the default branch by patch identity only, or a fast-forward. */
  | "likely-merged"
  /** Git found the head nowhere on the default branch, as of the last fetch. */
  | "not-on-default"
  /** The repository has no checkout linked on this machine. */
  | "no-checkout"
  /** The branch is gone from the remote and its content is on no default-branch commit. */
  | "branch-deleted"
  /** The unpushed branch never moved from the default-branch commit it was created at. */
  | "empty-branch";

export interface BranchOutcome {
  repository: string;
  branch: string;
  /** What is now known; `unknown` when Git could not settle it. */
  result: MergeState | "unknown";
  pr?: string;
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

/** A local checkout of a repository linked on this machine, for merge checks. */
export interface LocalMergeAccess {
  git: MergeGit;
  defaultBranch: string;
  /** Fetches the default branch and `branch`, at most once per branch. */
  fetch(branch: string): Promise<FetchResult>;
  /** The checkout's parsed `origin`, which alone names the host for a PR URL. */
  remote(): Promise<RemoteRepo | null>;
  /** The remote's pull and merge request heads, listed at most once. */
  pullRefs(): Promise<PullRef[] | null>;
}

/** The clock and the local Git a refresh reads. */
export interface RefreshAccess {
  now: () => Date;
  /** The repository's linked checkout, or null without one. */
  localAccess?: (repository: string) => Promise<LocalMergeAccess | null>;
  /**
   * Fetch, and list pull refs, before a local check: the companion's Git mode is `auto`, or
   * `--fetch` was passed.
   */
  fetch?: boolean;
}

export interface RefreshOptions extends RefreshAccess {
  /** Restricts the refresh to one repository's delivery. */
  repository?: string;
  /** Shared across changes in one run, so a branch is asked about once. */
  cache?: RefreshCache;
}

/**
 * True when a delivery's merge result is final: merged or dropped, by any source. Only
 * "not yet merged" is checked again; Git records nothing but merged.
 */
export function isSettled(delivery: Delivery): boolean {
  return delivery.merge !== undefined && delivery.merge.state !== "open";
}

/**
 * Checks every unsettled branch delivery of a record (or the one repository named) in its
 * linked checkout and records each merge Git proves, with source `git`, the merge commit and
 * time, the branch head Git resolved, and a PR the remote advertises for it. A direct
 * delivery is never settled here: it always needs the user's answer. Nothing is recorded for
 * a suggestion or a branch Git found nowhere: those come back as outcomes needing an answer.
 * A delivery already merged or dropped is skipped without a Git command.
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
    if (isSettled(delivery)) continue;
    const { repository, branch } = delivery;
    const head = delivery.head && isCommitId(delivery.head) ? delivery.head : undefined;
    const direct = Boolean(delivery.direct);
    const unpushed = delivery.unpushed === true;
    const key = JSON.stringify([
      repository.toLowerCase(),
      branch,
      direct,
      head,
      delivery.pr,
      unpushed,
    ]);

    let outcome = cache.get(key);
    if (!outcome) {
      // oxlint-disable-next-line no-await-in-loop -- one branch at a time, so the cache is shared
      outcome = await lookup(repository, branch, direct, { head, unpushed }, delivery.pr, options);
      cache.set(key, outcome);
    }
    outcomes.push(outcome);

    if (outcome.result === "merged") {
      const merge = {
        state: outcome.result,
        source: "git" as const,
        checkedAt: options.now().toISOString(),
        ...outcome.provenance,
      };
      next = upsertDelivery(next, repository, { merge });
    }
    if (outcome.head && outcome.head !== delivery.head) {
      next = upsertDelivery(next, repository, { head: outcome.head });
    }
    if (outcome.unpushed !== undefined && outcome.unpushed !== unpushed) {
      next = upsertDelivery(next, repository, { unpushed: outcome.unpushed });
    }
    // A recorded PR is kept; a found one is added without dropping the merge just recorded.
    if (outcome.pr && !delivery.pr) {
      const merge = findDelivery(next, repository)?.merge;
      next = upsertDelivery(next, repository, { pr: outcome.pr, ...(merge ? { merge } : {}) });
    }
  }
  return { record: next, outcomes: outcomes.map(publicOutcome) };
}

/** Lookups by repository, branch, mode, head, PR and the unpushed mark. */
export type RefreshCache = Map<string, LookupOutcome>;

interface LookupOutcome extends BranchOutcome {
  provenance?: MergeProvenance;
  /** The branch head Git resolved, recorded as the delivery's `head`. */
  head?: string;
  /** Whether `head` is missing from `origin/<branch>`; absent when this checkout cannot tell. */
  unpushed?: boolean;
}

function publicOutcome(outcome: LookupOutcome): BranchOutcome {
  const { provenance: _provenance, head: _head, unpushed: _unpushed, ...rest } = outcome;
  return rest;
}

/** Whether `head` is missing from `origin/<branch>`; undefined when no ref can tell. */
async function unpushedHead(
  git: MergeGit,
  branch: string,
  head: string,
): Promise<boolean | undefined> {
  const remote = await git.remoteTip(branch);
  if (remote) return remote !== head && !(await git.aheadOf(head, remote));
  // A branch that exists only locally was never pushed.
  return (await git.localTip(branch)) === head ? true : undefined;
}

async function hasNoCommitsOfItsOwn(
  git: MergeGit,
  branch: string,
  head: string,
  local: { tip: string | null; unpushed: boolean },
): Promise<boolean> {
  if (local.tip !== head) return false;
  if ((await git.neverAdvanced(branch, head)) !== true) return false;
  return local.unpushed || (await unpushedHead(git, branch, head)) === true;
}

function answerReasonOf(evidence: LocalMergeEvidence, deleted: boolean): AnswerReason {
  if (evidence.empty) return "empty-branch";
  if (evidence.suggestion) return "likely-merged";
  return deleted ? "branch-deleted" : "not-on-default";
}

async function lookup(
  repository: string,
  branch: string,
  direct: boolean,
  recorded: { head: string | undefined; unpushed: boolean },
  recordedPr: string | undefined,
  options: RefreshOptions,
): Promise<LookupOutcome> {
  const recordedHead = recorded.head;
  const base = { repository, branch };
  if (direct) {
    // Git cannot tell this change's commits from the user's other pushes, so the user decides.
    return { ...base, result: "unknown", needsAnswer: true, answerReason: "direct" };
  }
  // Only a checkout linked on this machine is inspected; a record never names one.
  const local = await options.localAccess?.(repository);
  if (!local) return { ...base, result: "unknown", needsAnswer: true, answerReason: "no-checkout" };

  const fetch = options.fetch ? await local.fetch(branch) : undefined;
  const withFetch = fetch ? { fetch } : {};
  const fetchedAt = await local.git.lastFetchedAt();
  let pullHead: string | null = null;
  const tip = await local.git.tip(branch);
  const known = recordedHead && (await local.git.hasCommit(recordedHead)) ? recordedHead : null;
  // A recorded head this checkout lacks is newer than its refs: an older tip settles nothing,
  // unless a fetch just showed the branch as the remote has it. A head recorded as unpushed is
  // not what the remote has, so there neither the fetched tip nor the PR's head stands in for it.
  const behind =
    Boolean(recordedHead) && !known && (recorded.unpushed || !(fetch?.ok && !fetch.branchDeleted));
  const live = behind ? null : tip;
  if (!live && !known && options.fetch && !recorded.unpushed) {
    const pr = await recordedPullRequest(local, recordedPr);
    pullHead = pr ? await local.git.fetchPullHead(pr.number, pr.ref) : null;
  }
  const evidence = await localMergeEvidence(local.git, local.defaultBranch, branch, recordedHead, {
    live,
    fallback: pullHead,
    unpushed: recorded.unpushed,
  });
  const head = evidence.head ?? undefined;
  const pr = head && options.fetch && !recordedPr ? await pullRequestFor(local, head) : null;
  const unpushed = head && !behind ? await unpushedHead(local.git, branch, head) : undefined;
  const found = {
    ...(head ? { head } : {}),
    ...(pr ? { pr } : {}),
    ...(unpushed !== undefined ? { unpushed } : {}),
  };

  if (evidence.merged) {
    const provenance: MergeProvenance = evidence.containing
      ? { mergeCommit: evidence.containing.commit, mergedAt: evidence.containing.committedAt }
      : {};
    return { ...base, ...withFetch, ...found, result: "merged", needsAnswer: false, provenance };
  }
  const { suggestion } = evidence;
  const neverPushed = fetch?.branchDeleted === true && (recorded.unpushed || unpushed === true);
  const reportedFetch = neverPushed ? { fetch: { ok: true, branchUnpushed: true } } : withFetch;
  // Without a fetch a missing `origin/<branch>` is no evidence of deletion.
  const deleted = fetch?.branchDeleted === true && !neverPushed && evidence.uncontained;
  return {
    ...base,
    ...reportedFetch,
    ...found,
    result: "unknown",
    needsAnswer: true,
    answerReason: answerReasonOf(evidence, deleted),
    ...(suggestion ? { suggestion } : {}),
    fetchedAt,
  };
}

/**
 * The recorded PR, only when its URL is the one this checkout's remote builds for its number:
 * a record a teammate edited must not make Mate fetch another repository's PR of that number.
 */
async function recordedPullRequest(
  local: LocalMergeAccess,
  recordedPr: string | undefined,
): Promise<ReturnType<typeof pullRequestOf>> {
  const pr = pullRequestOf(recordedPr);
  const remote = pr ? await local.remote() : null;
  const expected = remote && pr ? pullRequestUrl(remote, pr.number) : null;
  return expected && sameUrl(expected, recordedPr!) ? pr : null;
}

/** A PR URL without query, fragment or trailing slash, lower-cased. */
function normalizeUrl(url: string): string {
  return url
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function sameUrl(a: string, b: string): boolean {
  return normalizeUrl(a) === normalizeUrl(b);
}

/**
 * The URL of the one PR whose head is `head`, built from the checkout's remote. Anyone may open
 * a PR from a fork on the same commit, so several are no answer.
 */
async function pullRequestFor(local: LocalMergeAccess, head: string): Promise<string | null> {
  const refs = await local.pullRefs();
  const matches = (refs ?? []).filter((entry) => entry.commit === head);
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const remote = await local.remote();
  return remote ? pullRequestUrl(remote, match.number) : null;
}

/** What a local checkout alone knows about a branch's merge; no fetch. */
export interface LocalMergeEvidence {
  /** The branch tip, on `origin` or local; null when the branch is gone. */
  live: string | null;
  /**
   * `live`, or the local branch or recorded head while it is ahead of `live`; without `live`
   * the recorded head while the commit exists, else a fetched PR head.
   */
  head: string | null;
  /** A merge commit, or a default-branch commit holding the head's content, settles it. */
  merged: boolean;
  /** The first default-branch commit containing the head, when containment settled it. */
  containing?: { commit: string; committedAt: string };
  /** Short of `merged`: a head on the default branch's own line, else a patch match on old Git. */
  suggestion: PatchMatch | null;
  /** Containment ran and found no default-branch commit holding the head. */
  uncontained: boolean;
  /** The unpushed head is on the default branch and its branch never moved from it. */
  empty?: boolean;
}

/**
 * The merge evidence for a branch: ancestry first (a merge commit settles, unless the head is
 * recorded as unpushed, which it only suggests; a first-parent position is a fast-forward
 * suggestion), then content containment, else on Git without
 * `merge-tree --write-tree` (or when containment cannot tell) a patch-identity suggestion. A
 * recorded head is used only when it is a full commit ID present in the checkout. A local
 * branch or recorded head ahead of the remote tip is the head; a rewritten remote wins.
 */
export async function localMergeEvidence(
  git: MergeGit,
  defaultBranch: string,
  branch: string,
  recordedHead: string | undefined,
  known: { live?: string | null; fallback?: string | null; unpushed?: boolean } = {},
): Promise<LocalMergeEvidence> {
  const live = known.live !== undefined ? known.live : await git.tip(branch);
  const recorded =
    recordedHead && isCommitId(recordedHead) && (await git.hasCommit(recordedHead))
      ? recordedHead
      : null;
  let head = live ?? recorded ?? known.fallback ?? null;
  const localTip = head ? await git.localTip(branch) : null;
  if (live) {
    // Unpushed work: the remote tip alone would settle a merge of the branch's earlier commits.
    for (const candidate of [localTip, recorded]) {
      // oxlint-disable-next-line no-await-in-loop -- the second candidate is compared to the first
      if (candidate && (await git.aheadOf(head!, candidate))) head = candidate;
    }
  }
  const unsettled = { live, head, merged: false, uncontained: false };
  if (!head) return { ...unsettled, suggestion: null };
  if (await git.isAncestor(head, defaultBranch)) {
    const local = { tip: localTip, unpushed: known.unpushed === true };
    if (await hasNoCommitsOfItsOwn(git, branch, head, local)) {
      return { ...unsettled, empty: true, suggestion: null };
    }
    // A fast-forward and a branch without commits of its own look the same: only a merge
    // commit settles by itself, and a check Git could not run settles nothing.
    if ((await git.onFirstParent(head, defaultBranch)) === false) {
      // A head never pushed as its branch may be the tip the branch started from: the merge of
      // that other branch brought it, not this delivery's work.
      if (known.unpushed) return { ...unsettled, suggestion: { commit: head, style: "merge" } };
      return { ...unsettled, merged: true, suggestion: null };
    }
    return { ...unsettled, suggestion: { commit: head, style: "fast-forward" } };
  }
  const containing = await git.firstContaining(head, defaultBranch);
  if (typeof containing === "object") {
    return { ...unsettled, merged: true, containing, suggestion: null };
  }
  if (containing === "none") return { ...unsettled, uncontained: true, suggestion: null };
  return { ...unsettled, suggestion: await git.patchMatch(head, defaultBranch) };
}
