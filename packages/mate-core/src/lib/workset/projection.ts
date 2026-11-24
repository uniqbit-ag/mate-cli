import type { Operator } from "./claims";
import type { InventoryWorkset } from "./inventory";
import type { DerivedWorksetStage, WorksetStageId } from "./stage";

// Kept free of Node modules so Studio's Work view can read the same policy.

/**
 * Where a Workset's card sits and which Work actions it accepts. Every input is derived:
 * delivery stage, shared presence and sync, the claim and progress on a Delivery Branch.
 * Nothing here is stored.
 */

export const WORK_BUCKETS = ["scratchpad", "local", "remote"] as const;
export type WorkBucket = (typeof WORK_BUCKETS)[number];

export const WORK_ACTIONS = ["share", "claim", "release", "start-manual"] as const;
export type WorkActionId = (typeof WORK_ACTIONS)[number];

export type SharedPresence = "local" | "shared" | "partial" | "unknown";

/** The checkout against the shared tip, measured from their merge-base. */
export type SyncState = "in-sync" | "ahead" | "behind" | "diverged";

export interface SharingFacts {
  presence: SharedPresence;
  /** Active members the shared branch lacks. */
  missingMembers: string[];
  sync: SyncState;
  /** Discovery failed or never ran; placement is the last known one. */
  stale: boolean;
  /** Only the shared branch has it; `mate artifact take` brings it into the checkout. */
  remoteOnly: boolean;
}

export const LOCAL_ONLY: SharingFacts = {
  presence: "local",
  missingMembers: [],
  sync: "in-sync",
  stale: false,
  remoteOnly: false,
};

export interface WorkMemberStatus {
  name: string;
  stage: WorksetStageId;
  stageLabel: string;
  delivered: boolean;
  /** A member the group cannot complete without; named on the group card. */
  problem?: string;
}

export type Claim =
  | { kind: "none" }
  | { kind: "mine"; label: string }
  | { kind: "other"; label: string; id: string }
  | { kind: "conflict"; diagnostic: string };

/** A recorded Delivery Branch: here when a local Working Repository checkout has it. */
export type Progress =
  | { kind: "none" }
  | { kind: "here"; branch: string }
  | { kind: "elsewhere"; branch: string };

export interface WorkFacts {
  inventory: InventoryWorkset;
  stage: DerivedWorksetStage;
  members: WorkMemberStatus[];
  sharing: SharingFacts;
  claim: Claim;
  progress: Progress;
}

export interface WorkContext {
  writable: boolean;
  /** Configured Git identity; claims need it. */
  operator?: Operator;
  /** False outside Git: no sharing or claims. */
  gitBacked: boolean;
}

export interface WorkCard {
  id: string;
  bucket: WorkBucket;
  claim: Claim;
  progress: Progress;
  stage: WorksetStageId;
  stageLabel: string;
  sharing: SharingFacts;
  members: WorkMemberStatus[];
  done: boolean;
  /** Action → `null` when accepted now, else why it is refused. Irrelevant ones are absent. */
  actions: Partial<Record<WorkActionId, string | null>>;
  diagnostics: string[];
}

const COMPLETED: ReadonlySet<WorksetStageId> = new Set(["merge-wait", "publish", "done"]);
/** Past apply: submitted, or archived before submit existed. */
const SUBMITTED = "submitted for publication; nothing is left to do here";

function isShared(sharing: SharingFacts): boolean {
  return sharing.presence === "shared" || sharing.presence === "partial";
}

function activeCount(facts: WorkFacts): number {
  return facts.inventory.members.filter((member) => member.kind === "active").length;
}

export type OwnershipFacts = Pick<WorkFacts, "sharing" | "claim" | "progress">;

/** Unshared, claimed by the operator, or built here: the operator may start it. */
function isOwnWork(facts: OwnershipFacts): boolean {
  return !isShared(facts.sharing) || facts.claim.kind === "mine" || facts.progress.kind === "here";
}

export function bucketOf(facts: WorkFacts): WorkBucket {
  if (facts.inventory.members.length === 0 && !isShared(facts.sharing)) return "scratchpad";
  return isOwnWork(facts) ? "local" : "remote";
}

function first(...reasons: (string | null)[]): string | null {
  return reasons.find((reason) => reason !== null) ?? null;
}

/** Why the operator may not start it, or `null`. */
function notOwn(facts: OwnershipFacts): string | null {
  // A teammate's claim wins over a local branch of the same name.
  if (facts.claim.kind === "other") return `claimed by ${facts.claim.label}`;
  if (isOwnWork(facts)) return null;
  if (facts.progress.kind === "elsewhere") return `in progress on ${facts.progress.branch}`;
  return "claim it first";
}

function unsynced(sharing: SharingFacts): string | null {
  if (sharing.remoteOnly) {
    return "take its changes into this checkout first with `mate artifact take`";
  }
  if (sharing.sync === "behind" || sharing.sync === "diverged") {
    return "the shared version has changes this checkout lacks; take it with `mate artifact take` first";
  }
  return null;
}

/** Why a start of this Workset is refused for ownership or sync, or `null`. */
export function startRefusalOf(facts: OwnershipFacts): string | null {
  if (facts.claim.kind === "conflict") return facts.claim.diagnostic;
  return first(notOwn(facts), unsynced(facts.sharing));
}

/** Why `action` is refused for this Workset now, or `null` when it is accepted. */
export function workActionRefusal(
  action: WorkActionId,
  facts: WorkFacts,
  context: WorkContext,
): string | null {
  if (!context.writable) return "Studio is read-only; start it with --writable";
  if (!facts.inventory.actionable) {
    return facts.inventory.diagnostics[0] ?? "this Workset cannot be acted on";
  }
  if (facts.claim.kind === "conflict") return facts.claim.diagnostic;
  const { sharing } = facts;
  const hasChanges = activeCount(facts) > 0;
  const stage = facts.stage.stage;
  const missingIdentity = context.operator
    ? null
    : "configure Git user.name and user.email in the companion first";

  switch (action) {
    case "share":
      if (!context.gitBacked) return "the companion is not a Git repository";
      if (!hasChanges) return "Scratchpad ideas are not shared; propose the change first";
      if (COMPLETED.has(stage)) return SUBMITTED;
      if (sharing.presence === "shared" && sharing.sync === "in-sync") {
        return "already shared with no local changes";
      }
      return first(unsynced(sharing), notOwn(facts));
    case "claim":
      if (!isShared(sharing)) return "only shared work is claimed";
      if (COMPLETED.has(stage)) return SUBMITTED;
      if (sharing.presence === "partial") {
        return `not all of its changes are shared (${sharing.missingMembers.join(", ")})`;
      }
      if (facts.claim.kind === "mine") return "already yours";
      if (facts.claim.kind === "other") return `claimed by ${facts.claim.label}`;
      if (facts.progress.kind !== "none") return `in progress on ${facts.progress.branch}`;
      return missingIdentity;
    case "release":
      if (facts.claim.kind !== "mine") return "only its owner can release it";
      return missingIdentity;
    case "start-manual":
      if (!hasChanges) return "propose the change first";
      if (stage === "done") return "already delivered";
      if (COMPLETED.has(stage)) return SUBMITTED;
      return first(notOwn(facts), unsynced(sharing));
  }
}

function relevantActions(bucket: WorkBucket, facts: WorkFacts): WorkActionId[] {
  const actions: WorkActionId[] = [];
  if (bucket === "remote") actions.push("claim");
  if (bucket === "local") actions.push("share", "start-manual");
  if (facts.claim.kind === "mine") actions.push("release");
  return actions;
}

/** The card for one Workset. */
export function projectWorkCard(facts: WorkFacts, context: WorkContext): WorkCard {
  const bucket = bucketOf(facts);
  const actions: Partial<Record<WorkActionId, string | null>> = {};
  for (const action of relevantActions(bucket, facts)) {
    actions[action] = workActionRefusal(action, facts, context);
  }
  const diagnostics = [
    ...facts.inventory.diagnostics,
    ...(facts.claim.kind === "conflict" ? [facts.claim.diagnostic] : []),
    ...facts.members.flatMap((member) =>
      member.problem ? [`${member.name}: ${member.problem}`] : [],
    ),
    ...(facts.sharing.presence === "partial"
      ? [`not shared yet: ${facts.sharing.missingMembers.join(", ")}`]
      : []),
  ];
  return {
    id: facts.inventory.id,
    bucket,
    claim: facts.claim,
    progress: facts.progress,
    stage: facts.stage.stage,
    stageLabel: facts.stage.label,
    sharing: facts.sharing,
    members: facts.members,
    done:
      facts.members.length > 0
        ? facts.members.every((member) => member.delivered)
        : facts.stage.stage === "done",
    actions,
    diagnostics,
  };
}
