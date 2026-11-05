import { locateChange } from "../change-layout";
import { findWorkset, resolveWorksetBranch, resolveWorksetOf } from "../workset/record";
import {
  defaultDeliveryBranch,
  findDelivery,
  readDeliveryRecord,
  type DeliveryRecord,
} from "./record";

/** True when the ref resolves in the repository's checkout. */
export type HasRef = (ref: string) => Promise<boolean>;

/** Where the resolved branch lives: a local branch, only `origin/<branch>`, or nowhere yet. */
export type BranchSource = "local" | "remote" | "new";

export interface DeliveryBranchRequest {
  companionPath: string;
  /** Null when no repository is known; recorded branches are then not consulted. */
  repository: string | null;
  /** Null when no checkout is known: the computed name, with `source` null. */
  hasRef: HasRef | null;
}

export interface DeliveryBranchResolution {
  /** Null on a Workset identity problem or when its changes record different branches. */
  branch: string | null;
  /** Null when `branch` is null or no checkout was probed. */
  source: BranchSource | null;
  /** The Workset's single distinct ticket, or null for none or several. */
  ticket: string | null;
  diagnostics: string[];
}

/** The records of the Workset's changes: an explicit record's `changes`, else the change itself. */
async function memberRecords(companionPath: string, worksetId: string): Promise<DeliveryRecord[]> {
  const workset = await findWorkset(companionPath, worksetId);
  const changes = workset ? workset.changes : [worksetId];
  const records = await Promise.all(
    changes.map(async (change) => {
      const location = await locateChange(companionPath, change);
      return location ? readDeliveryRecord(location.dir) : null;
    }),
  );
  return records.filter((record): record is DeliveryRecord => record !== null);
}

function distinct(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function sourceOf(branch: string, hasRef: HasRef): Promise<BranchSource> {
  if (await hasRef(`refs/heads/${branch}`)) return "local";
  if (await hasRef(`refs/remotes/origin/${branch}`)) return "remote";
  return "new";
}

/** Branch order for a Workset whose identity is already checked. */
async function branchOf(
  request: DeliveryBranchRequest,
  worksetId: string,
): Promise<DeliveryBranchResolution> {
  const { companionPath, repository, hasRef } = request;
  const records = await memberRecords(companionPath, worksetId);
  const diagnostics: string[] = [];
  const tickets = distinct(records.map((record) => record.ticket));
  if (tickets.length > 1) {
    diagnostics.push(
      `Workset ${worksetId}'s changes record different tickets (${tickets.join(", ")}); its computed branch carries none.`,
    );
  }
  const ticket = tickets.length === 1 ? tickets[0]! : null;
  const resolved = async (branch: string, source?: BranchSource) => ({
    branch,
    source: source ?? (hasRef ? await sourceOf(branch, hasRef) : null),
    ticket,
    diagnostics,
  });

  if (repository) {
    const recorded = distinct(
      records.map((record) => {
        const delivery = findDelivery(record, repository);
        return delivery?.direct ? undefined : delivery?.branch;
      }),
    );
    if (recorded.length > 1) {
      diagnostics.push(
        `Workset ${worksetId}'s changes record different branches for ${repository} (${recorded.join(", ")}); select a branch explicitly.`,
      );
      return { branch: null, source: null, ticket, diagnostics };
    }
    if (recorded.length === 1) return resolved(recorded[0]!);
  }

  const computed = defaultDeliveryBranch(worksetId, ticket);
  if (hasRef) {
    const candidates = distinct([ticket ? computed : undefined, defaultDeliveryBranch(worksetId)]);
    for (const candidate of candidates) {
      // oxlint-disable-next-line no-await-in-loop -- the first existing candidate wins
      const source = await sourceOf(candidate, hasRef);
      if (source !== "new") return resolved(candidate, source);
    }
  }
  return resolved(computed, hasRef ? "new" : undefined);
}

/**
 * The Delivery Branch link, worktree, and factory spawning share, for a change or a Workset in
 * `repository`: the Workset identity check, then the branch its changes record when they agree,
 * an existing `workset/<TICKET>-<id>`, an existing `workset/<id>`, else the computed name. Direct
 * deliveries are not a Workset's branch. Existence is read through `hasRef`, local branch first,
 * so callers fetch before resolving. A damaged record throws, as when it is read on its own.
 */
export async function resolveDeliveryBranch(
  request: DeliveryBranchRequest & ({ change: string } | { worksetId: string }),
): Promise<DeliveryBranchResolution & { worksetId: string | null }> {
  const repository = request.repository ?? undefined;
  const identity =
    "change" in request
      ? await resolveWorksetOf(request.companionPath, request.change, repository)
      : await resolveWorksetBranch(request.companionPath, request.worksetId, repository);
  if (identity.id === null) {
    return {
      worksetId: null,
      branch: null,
      source: null,
      ticket: null,
      diagnostics: identity.diagnostics,
    };
  }
  const resolution = await branchOf(request, identity.id);
  return {
    ...resolution,
    worksetId: identity.id,
    diagnostics: [...identity.diagnostics, ...resolution.diagnostics],
  };
}

/** `git worktree add` arguments that put `target` on the resolved branch. */
export function worktreeAddArgs(
  { branch, source }: { branch: string; source: BranchSource },
  target: string,
): string[] {
  if (source === "local") return ["worktree", "add", target, branch];
  if (source === "remote") {
    return ["worktree", "add", "--track", "-b", branch, target, `origin/${branch}`];
  }
  return ["worktree", "add", "--no-track", "-b", branch, target, "origin/HEAD"];
}
