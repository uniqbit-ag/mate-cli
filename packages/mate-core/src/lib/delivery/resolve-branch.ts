import { locateChange } from "../change-layout";
import type { MergeGit } from "./merge-git";
import { declaredDependencies } from "./overlap";
import { localMergeEvidence } from "./refresh";
import {
  findWorkset,
  resolveWorksetBranch,
  resolveWorksetOf,
  type WorksetRecord,
} from "../workset/record";
import {
  defaultDeliveryBranch,
  findDelivery,
  isJiraKey,
  readDeliveryRecord,
  type DeliveryRecord,
} from "./record";

/** True when the ref resolves in the repository's checkout. */
export type HasRef = (ref: string) => Promise<boolean>;

/** Full names of the refs under the given prefixes, e.g. `refs/heads/workset/`. */
export type ListRefs = (prefixes: string[]) => Promise<string[]>;

/** Where the resolved branch lives: a local branch, only `origin/<branch>`, or nowhere yet. */
export type BranchSource = "local" | "remote" | "new";

export interface DeliveryBranchRequest {
  companionPath: string;
  /** Null when no repository is known; recorded branches are then not consulted. */
  repository: string | null;
  /** Null when no checkout is known: the computed name, with `source` null. */
  hasRef: HasRef | null;
  /**
   * Finds an existing `workset/<TICKET>-<id>` when no ticket is given; without it only
   * `workset/<id>` is probed.
   */
  listRefs?: ListRefs | null;
  /**
   * Checks a dependency never checked for a merge before its branch is inherited; without it
   * such a branch is inherited with a diagnostic asking for a refresh.
   */
  mergeProbe?: MergeProbe | null;
  /**
   * Names the branch `workset/<TICKET>-<id>`, even over an existing `workset/<id>`; never
   * renames a recorded or inherited one. Defaults to the explicit Workset record's ticket,
   * which yields to any existing `workset/<id>` or `workset/<TICKET>-<id>`.
   */
  ticket?: string | null;
}

export interface DeliveryBranchResolution {
  /** Null on a Workset identity problem or an ambiguous branch. */
  branch: string | null;
  /** Null when `branch` is null or no checkout was probed. */
  source: BranchSource | null;
  /** The `dependsOn` changes whose branch `branch` is; empty when it is not inherited. */
  inheritedFrom: string[];
  diagnostics: string[];
}

interface Member {
  change: string;
  dir: string;
  record: DeliveryRecord | null;
}

/** The Workset's changes: an explicit record's `changes`, else the change itself. */
async function members(
  companionPath: string,
  worksetId: string,
  workset: WorksetRecord | undefined,
): Promise<Member[]> {
  const changes = workset ? workset.changes : [worksetId];
  const found = await Promise.all(
    changes.map(async (change) => {
      const location = await locateChange(companionPath, change);
      if (!location) return null;
      return { change, dir: location.dir, record: await readDeliveryRecord(location.dir) };
    }),
  );
  return found.filter((member): member is Member => member !== null);
}

function distinct(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function sourceOf(branch: string, hasRef: HasRef): Promise<BranchSource> {
  if (await hasRef(`refs/heads/${branch}`)) return "local";
  if (await hasRef(`refs/remotes/origin/${branch}`)) return "remote";
  return "new";
}

const WORKSET_REF = /^refs\/(?:heads|remotes\/origin)\/workset\//;

/** The key of `workset/<TICKET>-<id>`, else null. */
function ticketKeyOf(branch: string, worksetId: string): string | null {
  const prefix = "workset/";
  const suffix = `-${worksetId}`;
  if (!branch.startsWith(prefix) || !branch.endsWith(suffix)) return null;
  const key = branch.slice(prefix.length, -suffix.length);
  return isJiraKey(key) ? key : null;
}

/** Existing `workset/<TICKET>-<id>` branches, local or on `origin`, for any ticket. */
async function ticketedBranches(worksetId: string, listRefs: ListRefs): Promise<string[]> {
  const refs = await listRefs(["refs/heads/workset/", "refs/remotes/origin/workset/"]);
  return distinct(
    refs.map((ref) => {
      if (!WORKSET_REF.test(ref)) return undefined;
      const branch = `workset/${ref.replace(WORKSET_REF, "")}`;
      return ticketKeyOf(branch, worksetId) ? branch : undefined;
    }),
  ).toSorted();
}

/** A local checkout's merge check, without fetch or forge; see {@link mergeProbeWith}. */
export type MergeProbe = (
  branch: string,
  recordedHead: string | undefined,
) => Promise<"merged" | "squashed" | "open">;

/**
 * A {@link MergeProbe} over local Git: a merge commit settles `merged`, commits matched on the
 * default branch read as `squashed`. A head on the default branch's own line is `open`: it
 * may be a fast-forward, but then its commits are already there and continuing on it is safe.
 */
export function mergeProbeWith(git: MergeGit, defaultBranch: string): MergeProbe {
  return async (branch, recordedHead) => {
    const evidence = await localMergeEvidence(git, defaultBranch, branch, recordedHead);
    if (evidence.merged) return "merged";
    const style = evidence.suggestion?.style;
    return style === "squash" || style === "rebase" ? "squashed" : "open";
  };
}

const SETTLED: ReadonlySet<string> = new Set(["merged", "closed-unmerged"]);

interface Inherited {
  branch: string;
  from: string[];
  /** Dependencies whose merge state was never looked up and could not be probed. */
  unchecked: string[];
}

/**
 * The branches the Workset's direct `dependsOn` changes deliver in `repository` that are still
 * open (not direct, not merged or dropped, present when refs can be probed), each with the
 * dependencies recording it. A dependency never checked for a merge is probed locally when
 * `mergeProbe` is given; one that looks merged is skipped and named in `diagnostics`.
 */
async function inheritedBranches(
  companionPath: string,
  found: Member[],
  repository: string,
  { hasRef, mergeProbe }: Pick<DeliveryBranchRequest, "hasRef" | "mergeProbe">,
  diagnostics: string[],
): Promise<Inherited[]> {
  const own = new Set(found.map((member) => member.change));
  const declared = await Promise.all(found.map((member) => declaredDependencies(member.dir)));
  const names = [...new Set(declared.flat().filter((name) => !own.has(name)))].toSorted();
  const open = await Promise.all(
    names.map(async (name) => {
      const location = await locateChange(companionPath, name);
      const record = location ? await readDeliveryRecord(location.dir) : null;
      const delivery = record ? findDelivery(record, repository) : undefined;
      if (!delivery?.branch || delivery.direct || SETTLED.has(delivery.merge?.state ?? "")) {
        return null;
      }
      const { branch } = delivery;
      if (hasRef && (await sourceOf(branch, hasRef)) === "new") return null;
      if (delivery.merge !== undefined) return { name, branch, unchecked: false };
      if (!mergeProbe) return { name, branch, unchecked: true };
      const probed = await mergeProbe(branch, delivery.head);
      if (probed === "open") return { name, branch, unchecked: false };
      diagnostics.push(
        probed === "merged"
          ? `${branch} of ${name} is merged into the default branch; it is not inherited.`
          : `${branch} of ${name} looks squash-merged into the default branch; it is not inherited. If it is still open, run \`mate artifact link ${name} --confirm-open\`.`,
      );
      return null;
    }),
  );
  const branches = new Map<string, Inherited>();
  for (const entry of open) {
    if (!entry) continue;
    const inherited = branches.get(entry.branch) ?? {
      branch: entry.branch,
      from: [],
      unchecked: [],
    };
    inherited.from.push(entry.name);
    if (entry.unchecked) inherited.unchecked.push(entry.name);
    branches.set(entry.branch, inherited);
  }
  return [...branches.values()];
}

/** Branch order for a Workset whose identity is already checked. */
async function branchOf(
  request: DeliveryBranchRequest,
  worksetId: string,
): Promise<DeliveryBranchResolution> {
  const { companionPath, repository, hasRef, listRefs } = request;
  const workset = await findWorkset(companionPath, worksetId);
  const ticket = request.ticket ?? workset?.ticket ?? null;
  // The branch the ticket names; `workset/<id>` without one.
  const named = defaultDeliveryBranch(worksetId, ticket);
  const found = await members(companionPath, worksetId, workset);
  const records = found.flatMap((member) => (member.record ? [member.record] : []));
  const diagnostics: string[] = [];
  const unresolved = (): DeliveryBranchResolution => ({
    branch: null,
    source: null,
    inheritedFrom: [],
    diagnostics,
  });
  const resolved = async (
    branch: string,
    { source, inheritedFrom = [] }: { source?: BranchSource; inheritedFrom?: string[] } = {},
  ): Promise<DeliveryBranchResolution> => {
    if (ticket && branch !== named) {
      diagnostics.push(
        `Ticket ${ticket} does not name the branch: ${branch} already delivers Workset ${worksetId}.`,
      );
    }
    return {
      branch,
      source: source ?? (hasRef ? await sourceOf(branch, hasRef) : null),
      inheritedFrom,
      diagnostics,
    };
  };

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
      return unresolved();
    }
    if (recorded.length === 1) {
      const branch = recorded[0]!;
      const key = ticketKeyOf(branch, worksetId);
      // Only the branch name carries a ticket, so a wrong one is fixed by renaming the branch.
      if (request.ticket && key && key.toUpperCase() !== request.ticket.toUpperCase()) {
        const changes = found.map((member) => member.change).join(" ");
        diagnostics.push(
          `To change the ticket of ${branch} before it is pushed, run \`git branch -m ${branch} ${named}\`, then \`mate artifact link ${changes} --branch ${named}\`.`,
        );
      }
      return resolved(branch);
    }

    const inherited = await inheritedBranches(
      companionPath,
      found,
      repository,
      request,
      diagnostics,
    );
    if (inherited.length > 1) {
      const names = inherited.map((entry) => entry.branch).join(", ");
      diagnostics.push(
        `Workset ${worksetId}'s dependencies record different branches for ${repository} (${names}); none is inherited.`,
      );
    }
    if (inherited.length === 1) {
      const { branch, from, unchecked } = inherited[0]!;
      if (unchecked.length > 0) {
        diagnostics.push(
          `${branch} is inherited from ${unchecked.join(", ")}, whose merge state was never checked; if it is merged, run \`mate artifact link ${unchecked[0]} --refresh\`.`,
        );
      }
      return resolved(branch, { inheritedFrom: from });
    }
  }

  const plain = defaultDeliveryBranch(worksetId);
  if (!hasRef) return resolved(named);
  if (ticket) {
    const source = await sourceOf(named, hasRef);
    if (source !== "new") return resolved(named, { source });
    // An explicit ticket asks for its own branch; a stale plain one must not take its place.
    if (request.ticket) {
      if ((await sourceOf(plain, hasRef)) !== "new") {
        diagnostics.push(
          `Existing ${plain} is not used: ticket ${ticket} names ${named}; record ${plain} with --branch to keep it.`,
        );
      }
      return resolved(named, { source });
    }
    // A Workset record's ticket only names a branch none of whose forms exists yet.
  }
  const plainSource = await sourceOf(plain, hasRef);
  if (plainSource !== "new") return resolved(plain, { source: plainSource });
  if (!listRefs) return resolved(named, { source: "new" });
  // The ticket lives only in the branch name, so a branch created with one is found by name.
  const ticketed = await ticketedBranches(worksetId, listRefs);
  if (ticketed.length > 1) {
    diagnostics.push(
      `Workset ${worksetId} has several ticket branches (${ticketed.join(", ")}); select a branch explicitly.`,
    );
    return unresolved();
  }
  if (ticketed.length === 1) return resolved(ticketed[0]!);
  return resolved(named, { source: "new" });
}

/** A {@link ListRefs} over a Git runner that answers stdout, or null on failure. */
export function listRefsWith(git: (args: string[]) => Promise<string | null>): ListRefs {
  return async (prefixes) => {
    const stdout = await git(["for-each-ref", "--format=%(refname)", ...prefixes]);
    return stdout ? stdout.split("\n").filter(Boolean) : [];
  };
}

/**
 * The Delivery Branch link, worktree, and factory spawning share, for a change or a Workset in
 * `repository`: the Workset identity check, then the branch its changes record when they agree,
 * a branch inherited from a `dependsOn` change, then with a ticket `workset/<TICKET>-<id>`
 * (a record's ticket yields to any existing Workset branch); without one an existing
 * `workset/<id>`, else the single existing `workset/<TICKET>-<id>`, else `workset/<id>`. Direct
 * deliveries are not a Workset's branch. Existence is read through `hasRef`, local branch
 * first, so callers fetch before resolving. A damaged record throws, as
 * when it is read on its own.
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
      inheritedFrom: [],
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

/**
 * Start point of a new branch: `origin/HEAD`, else `origin/main` or `origin/master`, else
 * `HEAD`. A clone whose remote HEAD was never set has no `origin/HEAD`.
 */
export async function newBranchBase(hasRef: HasRef): Promise<string> {
  for (const name of ["HEAD", "main", "master"]) {
    // oxlint-disable-next-line no-await-in-loop -- the first existing ref wins
    if (await hasRef(`refs/remotes/origin/${name}`)) return `origin/${name}`;
  }
  return "HEAD";
}

/** `git worktree add` arguments that put `target` on the resolved branch; `base` starts a new one. */
export function worktreeAddArgs(
  { branch, source }: { branch: string; source: BranchSource },
  target: string,
  base = "origin/HEAD",
): string[] {
  if (source === "local") return ["worktree", "add", target, branch];
  if (source === "remote") {
    return ["worktree", "add", "--track", "-b", branch, target, `origin/${branch}`];
  }
  return ["worktree", "add", "--no-track", "-b", branch, target, base];
}
