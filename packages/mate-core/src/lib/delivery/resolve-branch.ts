import { locateChange } from "../change-layout";
import { companionBranchTemplate } from "./branches";
import type { DeliveryCheckout, HasRef, ListRefs } from "./checkout";
import { declaredDependencies } from "./overlap";
import {
  findWorkset,
  resolveWorksetBranch,
  resolveWorksetOf,
  type WorksetRecord,
} from "../workset/record";
import {
  branchTemplatePrefix,
  DEFAULT_BRANCH_TEMPLATE,
  matchBranchTemplate,
  type BranchTemplate,
} from "./branch-template";
import {
  defaultDeliveryBranch,
  findDelivery,
  readDeliveryRecord,
  type DeliveryRecord,
} from "./record";

/** Where the resolved branch lives: a local branch, only `origin/<branch>`, or nowhere yet. */
export type BranchSource = "local" | "remote" | "new";

/** What a Delivery Branch is resolved for: a change, or a Workset by id. */
export type DeliverySubject = {
  companionPath: string;
  /** Null when no repository is known; recorded branches are then not consulted. */
  repository: string | null;
} & ({ change: string } | { worksetId: string });

export interface DeliveryBranchOptions {
  /**
   * Names the branch with the template and this ticket, even over an existing branch without
   * one; never renames a recorded or inherited one. Defaults to the explicit Workset record's
   * ticket, which yields to any existing branch the template names for the Workset.
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
  /** Set when the companion's branch template is invalid and the default applies. */
  templateDiagnostic?: string;
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

const BRANCH_REF = /^refs\/(?:heads|remotes\/origin)\//;

/** The ticket key the template put into `branch` for the Workset, else null. */
function ticketKeyOf(branch: string, worksetId: string, template: BranchTemplate): string | null {
  return matchBranchTemplate(template, branch, worksetId)?.ticket ?? null;
}

/** Existing branches the template names for the Workset with any ticket, local or on `origin`. */
async function ticketedBranches(
  worksetId: string,
  listRefs: ListRefs,
  template: BranchTemplate,
): Promise<string[]> {
  if (!template.includes("{ticket}")) return [];
  const prefix = branchTemplatePrefix(template);
  const refs = await listRefs([`refs/heads/${prefix}`, `refs/remotes/origin/${prefix}`]);
  return distinct(
    refs.map((ref) => {
      if (!BRANCH_REF.test(ref)) return undefined;
      const branch = ref.replace(BRANCH_REF, "");
      return ticketKeyOf(branch, worksetId, template) ? branch : undefined;
    }),
  ).toSorted();
}

type Existing = { branch: string; source: BranchSource } | "ambiguous" | null;

/**
 * An existing branch the template names for the Workset: the one without a ticket, else the
 * single one with any ticket; `ambiguous` for several, reported in `diagnostics`. `probed` is a
 * branch already known not to exist.
 */
async function existingBranch(
  worksetId: string,
  template: BranchTemplate,
  { hasRef, listRefs }: DeliveryCheckout,
  diagnostics: string[],
  probed?: string,
): Promise<Existing> {
  const plain = defaultDeliveryBranch(worksetId, null, template);
  if (plain !== probed) {
    const source = await sourceOf(plain, hasRef);
    if (source !== "new") return { branch: plain, source };
  }
  // The ticket lives only in the branch name, so a branch created with one is found by name.
  const ticketed = await ticketedBranches(worksetId, listRefs, template);
  if (ticketed.length > 1) {
    diagnostics.push(
      `Workset ${worksetId} has several ticket branches (${ticketed.join(", ")}); select a branch explicitly.`,
    );
    return "ambiguous";
  }
  if (ticketed.length === 0) return null;
  return { branch: ticketed[0]!, source: await sourceOf(ticketed[0]!, hasRef) };
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
 * dependencies recording it. A dependency never checked for a merge is probed in the
 * checkout; one that looks merged is skipped and named in `diagnostics`.
 */
async function inheritedBranches(
  companionPath: string,
  found: Member[],
  repository: string,
  checkout: DeliveryCheckout | null,
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
      if (checkout && (await sourceOf(branch, checkout.hasRef)) === "new") return null;
      if (delivery.merge !== undefined) return { name, branch, unchecked: false };
      const probed = checkout ? await checkout.mergeProbe(branch, delivery.head) : null;
      if (probed === null) return { name, branch, unchecked: true };
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
  checkout: DeliveryCheckout | null,
  { companionPath, repository }: DeliverySubject,
  options: DeliveryBranchOptions,
  template: BranchTemplate,
  worksetId: string,
): Promise<DeliveryBranchResolution> {
  const workset = await findWorkset(companionPath, worksetId);
  const ticket = options.ticket ?? workset?.ticket ?? null;
  // The template's branch with the ticket; without it when there is none.
  const named = defaultDeliveryBranch(worksetId, ticket, template);
  // The same under the default template, for branches made before the team switched templates.
  const defaultNamed = defaultDeliveryBranch(worksetId, ticket);
  const found = await members(companionPath, worksetId, workset);
  const records = found.flatMap((member) => (member.record ? [member.record] : []));
  const diagnostics: string[] = [];
  if (options.ticket && !template.includes("{ticket}")) {
    diagnostics.push(
      `Ticket ${options.ticket} is not in the branch name: branchTemplate ${template} has no {ticket}.`,
    );
  }
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
    if (ticket && branch !== named && branch !== defaultNamed) {
      diagnostics.push(
        `Ticket ${ticket} does not name the branch: ${branch} already delivers Workset ${worksetId}.`,
      );
    }
    return {
      branch,
      source: source ?? (checkout ? await sourceOf(branch, checkout.hasRef) : null),
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
      const key =
        ticketKeyOf(branch, worksetId, template) ??
        ticketKeyOf(branch, worksetId, DEFAULT_BRANCH_TEMPLATE);
      // Only the branch name carries a ticket, so a wrong one is fixed by renaming the branch.
      if (options.ticket && key && key.toUpperCase() !== options.ticket.toUpperCase()) {
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
      checkout,
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

  const plain = defaultDeliveryBranch(worksetId, null, template);
  const followsDefault = (branch: string, source: BranchSource) => {
    diagnostics.push(
      `${branch} follows the default template ${DEFAULT_BRANCH_TEMPLATE}, not branchTemplate ${template}; it is used because it already exists.`,
    );
    return resolved(branch, { source });
  };
  if (!checkout) return resolved(named);
  const { hasRef } = checkout;
  if (ticket) {
    const source = await sourceOf(named, hasRef);
    if (source !== "new") return resolved(named, { source });
    if (defaultNamed !== named) {
      const defaultSource = await sourceOf(defaultNamed, hasRef);
      if (defaultSource !== "new") return followsDefault(defaultNamed, defaultSource);
    }
    // An explicit ticket asks for its own branch; a stale plain one must not take its place.
    if (options.ticket) {
      const stale = distinct([plain, defaultDeliveryBranch(worksetId)]).filter(
        (branch) => branch !== named,
      );
      for (const branch of stale) {
        // oxlint-disable-next-line no-await-in-loop -- at most two probes, reported in order
        if ((await sourceOf(branch, hasRef)) !== "new") {
          diagnostics.push(
            `Existing ${branch} is not used: ticket ${ticket} names ${named}; record ${branch} with --branch to keep it.`,
          );
        }
      }
      return resolved(named, { source });
    }
    // A Workset record's ticket only names a branch none of whose forms exists yet.
  }
  const existing = await existingBranch(worksetId, template, checkout, diagnostics);
  if (existing === "ambiguous") return unresolved();
  if (existing) return resolved(existing.branch, { source: existing.source });
  // A branch made before the team switched templates keeps resolving.
  if (template !== DEFAULT_BRANCH_TEMPLATE) {
    const fallback = await existingBranch(
      worksetId,
      DEFAULT_BRANCH_TEMPLATE,
      checkout,
      diagnostics,
      plain,
    );
    if (fallback === "ambiguous") return unresolved();
    if (fallback) return followsDefault(fallback.branch, fallback.source);
  }
  return resolved(named, { source: "new" });
}

/**
 * The Delivery Branch link, worktree, and factory spawning share, for a change or a Workset in
 * `repository`: the Workset identity check, then the branch its changes record when they agree,
 * a branch inherited from a `dependsOn` change, then with a ticket the template's name with it
 * (a record's ticket yields to any existing Workset branch); without one an existing branch the
 * template names without a ticket, else the single one with any ticket, else for a non-default
 * template the same under the default, else the name without a ticket. The default template
 * gives `workset/<id>` and `workset/<TICKET>-<id>`. Direct
 * deliveries are not a Workset's branch. The template is the companion's; an invalid one
 * counts as the default and is named in `templateDiagnostic`. Existence and merges are read
 * in `checkout`, local branch first, so callers fetch before resolving; a null checkout gives
 * the computed name with `source` null. A damaged record throws, as when it is read on its own.
 */
export async function resolveDeliveryBranch(
  checkout: DeliveryCheckout | null,
  subject: DeliverySubject,
  options: DeliveryBranchOptions = {},
): Promise<DeliveryBranchResolution & { worksetId: string | null }> {
  const repository = subject.repository ?? undefined;
  const setting = await companionBranchTemplate(subject.companionPath);
  const templateField = setting.diagnostic ? { templateDiagnostic: setting.diagnostic } : {};
  const identity =
    "change" in subject
      ? await resolveWorksetOf(subject.companionPath, subject.change, repository)
      : await resolveWorksetBranch(subject.companionPath, subject.worksetId, repository);
  if (identity.id === null) {
    return {
      worksetId: null,
      branch: null,
      source: null,
      inheritedFrom: [],
      diagnostics: identity.diagnostics,
      ...templateField,
    };
  }
  const resolution = await branchOf(checkout, subject, options, setting.template, identity.id);
  return {
    ...resolution,
    worksetId: identity.id,
    diagnostics: [...identity.diagnostics, ...resolution.diagnostics],
    ...templateField,
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
  if (source === "local") return ["worktree", "add", "--end-of-options", target, branch];
  if (source === "remote") {
    return [
      "worktree",
      "add",
      "--track",
      "-b",
      branch,
      "--end-of-options",
      target,
      `origin/${branch}`,
    ];
  }
  return ["worktree", "add", "--no-track", "-b", branch, "--end-of-options", target, base];
}
