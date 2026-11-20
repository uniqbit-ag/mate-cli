import { groupClaim, type Operator } from "./claims";
import { configuredOperator, workGit } from "./git-transaction";
import { readChangeLinks } from "./groups";
import { type InventoryWorkset, readWorkInventory, type WorkInventory } from "./inventory";
import { type Claim, type OwnershipFacts, type Progress, startRefusalOf } from "./projection";
import { findWorkset } from "./record";
import { branchCheckedOutHere } from "./repositories";
import {
  compareWorkset,
  planProblems,
  type RemoteBacklog,
  readTeamBacklog,
  remoteOnlyEntries,
} from "./sharing";

/**
 * Who may start a Workset here: every Work-specific start (manual, attended session,
 * factory dispatch) passes `startRefusal`. Starting needs the Workset to be unshared,
 * claimed by the operator, or in progress on a Delivery Branch checked out here. Nothing is
 * reserved or stored; a factory runner starts only what its own scratchpad queued.
 */

/** The claim from the shared branch; unshared work has none. */
function claimOf(
  entry: InventoryWorkset,
  backlog: RemoteBacklog,
  operator: Operator | undefined,
): Claim {
  const members = entry.members.filter((member) => member.kind === "active");
  const reads = members.flatMap((member) => {
    const remote = backlog.changes.get(member.name);
    return remote ? [remote.owner] : [];
  });
  if (reads.length === 0) return { kind: "none" };
  const claim = groupClaim(reads);
  if (claim.kind === "none") return claim;
  if (claim.kind === "conflict") return { kind: "conflict", diagnostic: claim.diagnostic };
  return operator && claim.owner.id === operator.id.toLowerCase()
    ? { kind: "mine", label: claim.owner.label }
    : { kind: "other", label: claim.owner.label, id: claim.owner.id };
}

/** A recorded Delivery Branch of any member, here when a local checkout has it. */
async function progressOf(
  companionPath: string,
  entry: InventoryWorkset,
  backlog: RemoteBacklog,
  branchHere: (branch: string) => Promise<boolean> = (branch) =>
    branchCheckedOutHere(companionPath, branch),
): Promise<Progress> {
  const names = entry.members.filter((member) => member.kind === "active").map((m) => m.name);
  const local = await Promise.all(
    names.map((name) =>
      readChangeLinks(companionPath, name).catch(() => ({ name, dependsOn: [], branches: [] })),
    ),
  );
  const branches = [
    ...new Set([
      ...local.flatMap((links) => links.branches),
      ...names.flatMap((name) => backlog.changes.get(name)?.links.branches ?? []),
    ]),
  ];
  if (branches.length === 0) return { kind: "none" };
  for (const branch of branches) {
    // oxlint-disable-next-line no-await-in-loop -- usually one branch per Workset
    if (await branchHere(branch)) return { kind: "here", branch };
  }
  return { kind: "elsewhere", branch: branches[0]! };
}

export async function ownershipFacts(
  companionPath: string,
  entry: InventoryWorkset,
  backlog: RemoteBacklog,
  operator: Operator | undefined,
  /** Shared by every Workset of one read; see `branchProbe`. */
  branchHere?: (branch: string) => Promise<boolean>,
): Promise<OwnershipFacts> {
  const [sharing, progress] = await Promise.all([
    compareWorkset(companionPath, entry, backlog),
    progressOf(companionPath, entry, backlog, branchHere),
  ]);
  return { sharing, claim: claimOf(entry, backlog, operator), progress };
}

/** The Workset named `id`, local or only on the shared branch. */
export function findEntry(
  inventory: WorkInventory,
  backlog: RemoteBacklog,
  id: string,
): InventoryWorkset | undefined {
  const local = inventory.worksets.find((entry) => entry.id === id);
  if (local) return local;
  const changes = new Set(
    inventory.worksets.flatMap((entry) => entry.members.map((member) => member.name)),
  );
  return remoteOnlyEntries(backlog, changes).find((entry) => entry.id === id);
}

export interface StartCheck {
  /** Manual delivery needs complete plans; factory planning does not. */
  needsPlan: boolean;
  inventory?: WorkInventory;
}

/** Why a Work-specific start of `id` is refused here, or `null`. */
export async function startRefusal(
  companionPath: string,
  id: string,
  check: StartCheck,
): Promise<string | null> {
  const [inventory, backlog] = await Promise.all([
    check.inventory ?? readWorkInventory(companionPath),
    readTeamBacklog(companionPath),
  ]);
  const entry = findEntry(inventory, backlog, id);
  if (!entry) return `no Workset ${id}`;
  if (!entry.actionable) return entry.diagnostics[0] ?? "it cannot be started";
  const operator = (await configuredOperator(workGit(companionPath))) ?? undefined;
  const refusal = startRefusalOf(await ownershipFacts(companionPath, entry, backlog, operator));
  if (refusal) return refusal;
  const members = entry.members.filter((member) => member.kind === "active").map((m) => m.name);
  if (check.needsPlan && members.length > 0) {
    const problems = await planProblems(companionPath, members);
    if (problems.length > 0) return problems.join("; ");
  }
  return null;
}

/**
 * The start guard of a served companion, as the factory's Outcomes and attended sessions use
 * it. `authorized`: only a scratchpad record (never a legacy shared one) queued here runs.
 */
export function companionExecutorGuard(companionPath: string) {
  return {
    async authorized(id: string): Promise<boolean> {
      const record = await findWorkset(companionPath, id);
      return !!record?.queuedAt && !record.legacy;
    },
    reserve(id: string): Promise<string | null> {
      return startRefusal(companionPath, id, { needsPlan: false });
    },
    /** Nothing is held, so nothing is released. */
    async release(_id: string): Promise<string | null> {
      return null;
    },
  };
}

/**
 * The guard before a Work action launches Studio's terminal: the subject's Workset (a
 * change's, for a change subject) must be startable here.
 */
export async function reserveManualLaunch(
  companionPath: string,
  subject: { kind: "workset" | "change"; name: string },
): Promise<string | null> {
  const inventory = await readWorkInventory(companionPath);
  const entry = inventory.worksets.find((candidate) =>
    subject.kind === "workset"
      ? candidate.id === subject.name
      : candidate.members.some(
          (member) => member.kind === "active" && member.name === subject.name,
        ),
  );
  if (!entry) return `this companion has no ${subject.kind} named ${subject.name}`;
  // Exploring and proposing an idea need no plan yet.
  const planning = entry.members.every((member) => member.kind !== "active");
  return startRefusal(companionPath, entry.id, { needsPlan: !planning, inventory });
}
