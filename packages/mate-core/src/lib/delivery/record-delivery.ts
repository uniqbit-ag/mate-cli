import type { ProtectionReason } from "./branches";
import { changeNameOf, locateChange, type ChangeLocation } from "../change-layout";
import { resolveWorksetOf } from "../workset/record";
import { companionRelative, type DeliveryEnvironment } from "./environment";
import {
  defaultDeliveryBranch,
  findDelivery,
  legacyDeliveryBranch,
  readOrUnlinkedRecord,
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
   * Ask the forge, then a local checkout, for each branch's merge state; a direct delivery
   * needs the user's answer instead.
   */
  refresh?: boolean;
  /** Fetch before a local check even when the companion's Git mode is not `auto`. */
  fetch?: boolean;
  /** Refresh every delivery even when `repository` names the one to edit. */
  refreshAll?: boolean;
  /** Archived changes may be edited; otherwise only active ones are found. */
  includeArchived?: boolean;
  /** A change left without any delivery answers `needsBranch` and nothing is written. */
  requireDelivery?: boolean;
}

export type DeliveryRefusal =
  | { reason: "unknown-change"; change: string }
  | { reason: "no-repository" }
  | { reason: "protected-branch"; branch: string; protection: ProtectionReason | null }
  | {
      reason: "no-delivery-branch";
      change: string;
      repository: string;
      for: "pr" | "confirm";
    };

export interface DeliveryResult {
  defaultBranch: string | null;
  diagnostics: string[];
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
  /** First existing safe default or legacy branch in the Working Repository. */
  suggestedBranch: string | null;
}

export type DeliveryOutcome =
  | { refusal: DeliveryRefusal }
  | { needsBranch: NeedsBranch }
  /** Every record is already written when the request edited or refreshed. */
  | { results: DeliveryResult[] };

export interface RecordDeliveryDeps extends RepositoryAccessDeps {
  now?: () => Date;
  repositoryAccess?: (repository: string) => RepositoryAccess;
}

function hasDeliveryBranch(record: DeliveryRecord, repository: string): boolean {
  return Boolean(findDelivery(record, repository)?.branch);
}

/**
 * Reads, edits, refreshes, and writes the Delivery Records of `request.changes`. Every
 * change resolves before any record is written, so a refusal leaves no partial update; a
 * request without an edit or refresh only reads. Network requests go only to the forge:
 * for another repository's default branch, and to refresh. `--direct` is
 * accepted on any branch; a protected one requires it.
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

  const repository = request.repository ?? environment.workingRepo?.slug ?? null;
  const edits = edit.delivery !== undefined || edit.pr !== undefined || edit.confirm !== undefined;
  if (edits && !repository) return { refusal: { reason: "no-repository" } };
  if (repository && edit.delivery && "branch" in edit.delivery) {
    const { branch, direct } = edit.delivery;
    const protection = await access(repository).protection(branch);
    if (protection.protected && !direct) {
      return { refusal: { reason: "protected-branch", branch, protection: protection.reason } };
    }
  }

  const refreshAccess: RefreshAccess = {
    now,
    forgeAccess: (repo) => access(repo).forge(),
    localAccess: async (repo) => (await access(repo).local?.()) ?? null,
    fetch: request.fetch === true || environment.gitAutoMode === true,
  };
  const cache: RefreshCache = new Map();
  const resolved: Array<DeliveryResult & { dir: string }> = [];

  for (const { change, dir, archived } of located) {
    let record = await readOrUnlinkedRecord(dir, change);
    const resolution = await resolveWorksetOf(
      environment.companionPath,
      change,
      repository ?? undefined,
    );
    const defaultBranch = resolution.id === null ? null : defaultDeliveryBranch(resolution.id);
    const diagnostics = [...resolution.diagnostics];
    const recordedBranch = repository ? findDelivery(record, repository)?.branch : undefined;
    if (recordedBranch && defaultBranch && recordedBranch !== defaultBranch) {
      diagnostics.push(
        `Recorded branch ${recordedBranch} differs from default ${defaultBranch}; preserving recorded delivery unless explicitly relinked.`,
      );
    }
    if (repository && edit.delivery) {
      record = upsertDelivery(record, repository, edit.delivery);
      // Recording a branch keeps its local tip, so a later deletion cannot hide the merge.
      if ("branch" in edit.delivery) {
        const local = await access(repository).local?.();
        const head = await local?.git.tip(edit.delivery.branch);
        if (head) record = upsertDelivery(record, repository, { head });
      }
    }

    if (request.requireDelivery && record.deliveries.length === 0) {
      let suggestedBranch: string | null = null;
      for (const candidate of [defaultBranch, legacyDeliveryBranch(changeNameOf(change))]) {
        if (candidate && (await environment.workingRepo?.git.branchExists(candidate))) {
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
    }

    if (repository && edit.confirm !== undefined) {
      if (!hasDeliveryBranch(record, repository)) {
        return { refusal: { reason: "no-delivery-branch", change, repository, for: "confirm" } };
      }
      record = upsertDelivery(record, repository, {
        merge: { state: edit.confirm, source: "user", checkedAt: now().toISOString() },
      });
    }

    resolved.push({
      defaultBranch,
      diagnostics,
      dir,
      change: record.change,
      path: companionRelative(environment, dir),
      archived,
      record,
      settlement: await settleChangeDir(dir, record),
      outcomes,
    });
  }

  if (edits || request.refresh) {
    for (const { dir, record } of resolved) await writeDeliveryRecord(dir, record);
  }
  const results = resolved.map(({ dir: _dir, ...result }) => result);
  return { results };
}
