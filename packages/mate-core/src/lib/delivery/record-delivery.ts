// oxlint-disable no-await-in-loop -- changes are recorded in order and the first refusal ends the run
import {
  workingRepoGit,
  type ProtectionReason,
  type TicketFormat,
  type WorkingRepoGit,
} from "./branches";
import { companionGit } from "../../runtime/companion-git";
import { changeNameOf, locateChange, type ChangeLocation } from "../change-layout";
import { scopedRepositories } from "../openspec-scopes";
import { companionRelative, type DeliveryEnvironment } from "./environment";
import {
  canaryTicketOf,
  findDelivery,
  isCommitId,
  ticketCandidateOf,
  legacyDeliveryBranch,
  readOrUnlinkedRecord,
  sameRepository,
  settleChangeDir,
  upsertDelivery,
  writeDeliveryRecord,
  type DeliveryRecord,
  type DeliverySettlement,
  type MergeState,
} from "./record";
import {
  refreshRecord,
  type BranchOutcome,
  type RefreshAccess,
  type RefreshCache,
} from "./refresh";
import { probeMerge, type DeliveryCheckout } from "./checkout";
import { resolveDeliveryBranch } from "./resolve-branch";
import { defaultRef, stagingRemote } from "./staging/refs";
import {
  repositoryAccessFor,
  type RepositoryAccess,
  type RepositoryAccessDeps,
} from "./repository-access";

/** Edits to one repository's delivery, applied in this order around an optional refresh. */
export interface DeliveryEdit {
  delivery?: { branch: string; direct: boolean } | { notApplicable: string };
  /** Informational PR URL; also picks the PR a refresh asks about. */
  pr?: string;
  /** The user's answer, recorded after any refresh with source `user`. */
  confirm?: MergeState;
  /**
   * Records the Delivery Branch resolved with this Jira key, which names a new branch by the
   * template (default `workset/<TICKET>-<id>`); the key itself is not stored. Refused while
   * tickets are off.
   */
  ticket?: string;
}

export interface DeliveryRequest {
  changes: string[];
  /**
   * The delivery to edit, and the only one refreshed unless `refreshAll`. Without it the
   * Working Repository's delivery is edited and every delivery is refreshed.
   */
  repository?: string;
  edit?: DeliveryEdit;
  /**
   * Check each branch's merge state in its checkout linked on this machine; a direct delivery
   * needs the user's answer instead.
   */
  refresh?: boolean;
  /** Fetch before a local check even when the companion's Git mode is not `auto`. */
  fetch?: boolean;
  /** Refresh every delivery even when `repository` names the one to edit. */
  refreshAll?: boolean;
  /** Record the companion's `HEAD` as the delta base when none is recorded; needs no repository. */
  specBase?: boolean;
  /**
   * Leave a missing `specBase` unset: the records are not in the user's checkout, such as
   * publication's settlement in a temporary worktree, whose `HEAD` is no delta base.
   */
  leaveSpecBase?: boolean;
  /** Archived changes may be edited; otherwise only active ones are found. */
  includeArchived?: boolean;
  /** A change left without any delivery answers `needsBranch` and nothing is written. */
  requireDelivery?: boolean;
  /** Resolve and refuse as usual, but write nothing. */
  dryRun?: boolean;
  /**
   * With `refresh`: refuse when Git settles a delivery as merged while a work tree that has its
   * branch checked out holds modified tracked files, since that work is on no commit.
   */
  refuseUncommitted?: boolean;
}

export type DeliveryRefusal =
  | { reason: "unknown-change"; change: string }
  | { reason: "no-repository" }
  /** An edit in an Umbrella Repository whose changes are scoped to not exactly one child. */
  | { reason: "umbrella-repository"; umbrella: string; scoped: string[]; children: string[] }
  | { reason: "tickets-off" }
  | { reason: "no-resolved-branch"; change: string; diagnostics: string[] }
  /** `--ticket` on a repository whose delivery is direct or not applicable. */
  | { reason: "settled-delivery"; change: string; repository: string; delivery: string }
  | { reason: "protected-branch"; branch: string; protection: ProtectionReason | null }
  /** `refuseUncommitted`: `worktree` has `branch` checked out with modified tracked files. */
  | {
      reason: "uncommitted-work";
      change: string;
      repository: string;
      branch: string;
      worktree: string;
    }
  | {
      reason: "no-delivery-branch";
      change: string;
      repository: string;
      for: "pr" | "confirm";
    };

export interface DeliveryResult {
  defaultBranch: string | null;
  /** The `dependsOn` changes `defaultBranch` is inherited from; empty when it is not. */
  inheritedFrom: string[];
  diagnostics: string[];
  /** The companion's ticket setting. */
  ticketFormat: TicketFormat;
  /**
   * With `ticketFormat` `jira`: the single Jira key in the branch recorded for the
   * repository, else in the Working Repository's current branch, upper-cased.
   */
  ticketCandidate: string | null;
  change: string;
  /** Companion-relative path of the change directory. */
  path: string;
  archived: boolean;
  record: DeliveryRecord;
  settlement: DeliverySettlement;
  /** Lookups made by the refresh, including the ones the user must answer. */
  outcomes: BranchOutcome[];
}

export interface NeedsBranch {
  defaultBranch: string | null;
  diagnostics: string[];
  change: string;
  record: DeliveryRecord;
  /** First existing safe default or legacy branch in the session's checkout of the repository. */
  suggestedBranch: string | null;
}

export type DeliveryOutcome =
  | { refusal: DeliveryRefusal }
  | { needsBranch: NeedsBranch }
  /** Every record is already written when the request edited or refreshed. */
  | { results: DeliveryResult[] };

export interface RecordDeliveryDeps extends RepositoryAccessDeps {
  now?: () => Date;
  /** The companion's `HEAD` commit; null when unknown. */
  companionHead?: (companionPath: string) => Promise<string | null>;
  repositoryAccess?: (repository: string) => RepositoryAccess;
}

/**
 * The commit the companion checkout's delta specs are written on: `HEAD`, or, while `HEAD`
 * holds commits the default branch as last fetched lacks, where it left that branch, since publication only reads a
 * base the default branch holds. Null when Git cannot tell.
 */
async function companionHead(companionPath: string): Promise<string | null> {
  const git = companionGit(companionPath, { prompt: "never" });
  const head = await git.run(["rev-parse", "HEAD"]);
  const commit = head.stdout.trim();
  if (head.status !== 0 || !isCommitId(commit)) return null;
  const remote = await stagingRemote(git);
  if (!remote) return commit;
  const shared = await git.run(["merge-base", "HEAD", defaultRef(remote)]);
  const base = shared.stdout.trim();
  return shared.status === 0 && isCommitId(base) ? base : commit;
}

/** Local Git of the repository's checkout; null when none is known. */
async function checkoutGit(
  environment: DeliveryEnvironment,
  repository: string,
): Promise<WorkingRepoGit | null> {
  const working = environment.workingRepo;
  if (working?.slug && sameRepository(working.slug, repository)) return working.git;
  const checkout = await environment.checkoutOf?.(repository);
  return checkout ? workingRepoGit(checkout) : null;
}

/** The Umbrella Repository's children the changes are scoped to, in scope order. */
async function scopedChildren(
  located: readonly { dir: string }[],
  children: readonly string[],
): Promise<string[]> {
  const scoped: string[] = [];
  for (const { dir } of located) {
    for (const repository of await scopedRepositories(dir)) {
      const child = children.find((entry) => sameRepository(entry, repository));
      if (child && !scoped.includes(child)) scoped.push(child);
    }
  }
  return scoped;
}

/**
 * The Git whose branches the session works on: the Working Repository's, or in an Umbrella
 * Repository, which is no checkout, the delivery's child checkout.
 */
async function sessionGitOf(
  environment: DeliveryEnvironment,
  repository: string | null,
): Promise<WorkingRepoGit | null> {
  const working = environment.workingRepo;
  if (!working?.umbrellaChildren) return working?.git ?? null;
  return repository ? checkoutGit(environment, repository) : null;
}

/**
 * The repository's local checkout for resolving its Delivery Branch; null when none is known.
 * Merges are checked through the repository's local merge access, without a fetch.
 */
async function deliveryCheckoutIn(
  environment: DeliveryEnvironment,
  repository: string,
  access: RepositoryAccess,
): Promise<DeliveryCheckout | null> {
  const git = await checkoutGit(environment, repository);
  if (!git) return null;
  return {
    hasRef: (ref) => git.hasRef(ref),
    listRefs: async (prefixes) => (await git.listRefs?.(prefixes)) ?? [],
    defaultBranch: () => git.defaultBranch(),
    mergeProbe: async (branch, recordedHead) => {
      const local = await access.local?.();
      return local ? probeMerge(local.git, local.defaultBranch, branch, recordedHead) : null;
    },
  };
}

/** A delivery a ticket must not replace: direct, or not applicable. */
function settledDelivery(record: DeliveryRecord, repository: string): string | null {
  const delivery = findDelivery(record, repository);
  if (delivery?.notApplicable !== undefined) return `not applicable (${delivery.notApplicable})`;
  return delivery?.direct ? `${delivery.branch} [direct]` : null;
}

function hasDeliveryBranch(record: DeliveryRecord, repository: string): boolean {
  return Boolean(findDelivery(record, repository)?.branch);
}

/**
 * Reads, edits, refreshes, and writes the Delivery Records of `request.changes`. Every
 * change resolves before any record is written, so a refusal leaves no partial update; a
 * request without an edit or refresh only reads. Network Git runs only in a linked checkout,
 * for a refresh whose fetch is allowed. `--direct` is accepted on any branch; a protected one
 * requires it.
 */
export async function recordDelivery(
  environment: DeliveryEnvironment,
  request: DeliveryRequest,
  deps: RecordDeliveryDeps = {},
): Promise<DeliveryOutcome> {
  const { edit = {} } = request;
  const now = deps.now ?? (() => new Date());
  const access = deps.repositoryAccess ?? repositoryAccessFor(environment, deps);

  const located: Array<ChangeLocation & { change: string }> = [];
  for (const change of request.changes) {
    const location = await locateChange(environment.companionPath, change);
    if (!location || (location.archived && !request.includeArchived)) {
      return { refusal: { reason: "unknown-change", change } };
    }
    located.push({ ...location, change });
  }

  const ticketFormat = environment.ticket?.format ?? "none";
  if (edit.ticket !== undefined && ticketFormat === "none") {
    return { refusal: { reason: "tickets-off" } };
  }
  const edits =
    edit.delivery !== undefined ||
    edit.pr !== undefined ||
    edit.confirm !== undefined ||
    edit.ticket !== undefined;
  const working = environment.workingRepo;
  let repository = request.repository ?? working?.slug ?? null;
  // In an Umbrella Repository the changes' only scoped child stands in for the Working Repository.
  if (!repository && working?.umbrellaChildren) {
    const children = working.umbrellaChildren;
    const scoped = await scopedChildren(located, children);
    if (scoped.length === 1) repository = scoped[0]!;
    else if (edits) {
      return {
        refusal: { reason: "umbrella-repository", umbrella: working.path, scoped, children },
      };
    }
  }
  if (edits && !repository) return { refusal: { reason: "no-repository" } };
  const refuseProtected = async (
    repo: string,
    branch: string,
    direct: boolean,
  ): Promise<{ refusal: DeliveryRefusal } | null> => {
    const protection = await access(repo).protection(branch);
    return protection.protected && !direct
      ? { refusal: { reason: "protected-branch", branch, protection: protection.reason } }
      : null;
  };
  if (repository && edit.delivery && "branch" in edit.delivery) {
    const refused = await refuseProtected(repository, edit.delivery.branch, edit.delivery.direct);
    if (refused) return refused;
  }

  const refreshAccess: RefreshAccess = {
    now,
    localAccess: async (repo) => (await access(repo).local?.()) ?? null,
    fetch: request.fetch === true || environment.gitAutoMode === true,
  };
  const cache: RefreshCache = new Map();
  const resolved: Array<DeliveryResult & { dir: string }> = [];
  const checkout = repository
    ? await deliveryCheckoutIn(environment, repository, access(repository))
    : null;
  const sessionGit = await sessionGitOf(environment, repository);
  const currentBranch = (await sessionGit?.currentBranch()) ?? null;

  for (const { change, dir, archived } of located) {
    let record = await readOrUnlinkedRecord(dir, change);
    const resolution = await resolveDeliveryBranch(
      checkout,
      { companionPath: environment.companionPath, repository, change },
      edit.ticket !== undefined ? { ticket: edit.ticket } : {},
    );
    // Reported once, on the first change, as it concerns the companion, not a change.
    const templateDiagnostic = resolved.length === 0 ? resolution.templateDiagnostic : null;
    const diagnostics = templateDiagnostic
      ? [templateDiagnostic, ...resolution.diagnostics]
      : resolution.diagnostics;
    const defaultBranch = resolution.branch;
    const recordedBranch = repository ? findDelivery(record, repository)?.branch : undefined;
    if (recordedBranch && defaultBranch && recordedBranch !== defaultBranch) {
      diagnostics.push(
        `Recorded branch ${recordedBranch} differs from default ${defaultBranch}; preserving recorded delivery unless explicitly relinked.`,
      );
    }
    const canaryTicket = record.deliveries.length === 0 ? await canaryTicketOf(dir) : null;
    if (canaryTicket) {
      diagnostics.push(
        `${change}'s record holds only ticket ${canaryTicket}, which Mate no longer reads; record the branch that delivered it with --branch.`,
      );
    }
    let delivery = edit.delivery;
    if (repository && edit.ticket !== undefined) {
      const settled = settledDelivery(record, repository);
      if (settled) {
        return { refusal: { reason: "settled-delivery", change, repository, delivery: settled } };
      }
      if (!defaultBranch) return { refusal: { reason: "no-resolved-branch", change, diagnostics } };
      const refused = await refuseProtected(repository, defaultBranch, false);
      if (refused) return refused;
      delivery = { branch: defaultBranch, direct: false };
    }
    if (repository && delivery) {
      record = upsertDelivery(record, repository, delivery);
      // Recording a branch keeps its local tip, so a later deletion cannot hide the merge.
      if ("branch" in delivery) {
        const local = await access(repository).local?.();
        const head = await local?.git.tip(delivery.branch);
        if (head) record = upsertDelivery(record, repository, { head });
      }
    }

    if (request.requireDelivery && record.deliveries.length === 0) {
      let suggestedBranch: string | null = null;
      for (const candidate of [defaultBranch, legacyDeliveryBranch(changeNameOf(change))]) {
        if (candidate && (await sessionGit?.branchExists(candidate))) {
          suggestedBranch = candidate;
          break;
        }
      }
      return { needsBranch: { change, record, defaultBranch, diagnostics, suggestedBranch } };
    }

    if (repository && edit.pr !== undefined) {
      if (!hasDeliveryBranch(record, repository)) {
        return { refusal: { reason: "no-delivery-branch", change, repository, for: "pr" } };
      }
      record = upsertDelivery(record, repository, { pr: edit.pr });
    }

    let outcomes: BranchOutcome[] = [];
    if (request.refresh) {
      const refreshed = await refreshRecord(record, {
        ...refreshAccess,
        cache,
        ...(request.repository && !request.refreshAll ? { repository: request.repository } : {}),
      });
      record = refreshed.record;
      outcomes = refreshed.outcomes;
      for (const outcome of request.refuseUncommitted ? outcomes : []) {
        if (outcome.result !== "merged") continue;
        const local = await access(outcome.repository).local?.();
        const worktree = await local?.git.dirtyWorktree(outcome.branch);
        if (worktree) {
          const { repository: repo, branch } = outcome;
          return {
            refusal: { reason: "uncommitted-work", change, repository: repo, branch, worktree },
          };
        }
      }
    }

    if (repository && edit.confirm !== undefined) {
      if (!hasDeliveryBranch(record, repository)) {
        return { refusal: { reason: "no-delivery-branch", change, repository, for: "confirm" } };
      }
      record = upsertDelivery(record, repository, {
        merge: { state: edit.confirm, source: "user", checkedAt: now().toISOString() },
      });
    }

    const candidateSource = recordedBranch ?? currentBranch;
    resolved.push({
      defaultBranch,
      inheritedFrom: resolution.inheritedFrom,
      diagnostics,
      ticketFormat,
      ticketCandidate:
        ticketFormat === "jira" && candidateSource ? ticketCandidateOf(candidateSource) : null,
      dir,
      change: record.change,
      path: companionRelative(environment, dir),
      archived,
      record,
      settlement: await settleChangeDir(dir, record),
      outcomes,
    });
  }

  if (!request.dryRun && (edits || request.refresh || request.specBase)) {
    // The first write of an active change's record keeps the base its delta specs were written on.
    let head: Promise<string | null> | undefined;
    for (const entry of resolved) {
      if (request.leaveSpecBase || entry.archived || entry.record.specBase) continue;
      head ??= (deps.companionHead ?? companionHead)(environment.companionPath);
      const specBase = await head;
      if (specBase) entry.record = { ...entry.record, specBase };
    }
    for (const { dir, record } of resolved) await writeDeliveryRecord(dir, record);
  }
  const results = resolved.map(({ dir: _dir, ...result }) => result);
  return { results };
}
