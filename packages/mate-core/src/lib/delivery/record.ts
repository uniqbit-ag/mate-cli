import fs from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";
import { errorMessage } from "../../runtime/error-message";
import { changeNameOf } from "../change-layout";
import { scopedRepositories } from "../openspec-scopes";

/** The Delivery Record's file name at a change root; it moves with the change into its archive. */
export const DELIVERY_FILE = "delivery.yaml";

/** A merge result: `open` is "not yet merged", `closed-unmerged` is "dropped". */
export type MergeState = "merged" | "open" | "closed-unmerged";

/** Where a merge result came from; a user answer is recorded as such, never as forge truth. */
export type MergeSource = "forge" | "user";

/** What the forge reports about a merge, when it reports anything. */
export interface MergeProvenance {
  mergedAt?: string;
  mergeCommit?: string;
  /** Provenance only; a merger is never presented as an artifact reviewer. */
  mergedBy?: string;
}

export interface MergeResult extends MergeProvenance {
  state: MergeState;
  source: MergeSource;
  /** When the result was recorded (ISO 8601). */
  checkedAt: string;
}

/** The provenance fields `source` carries, without empty ones. */
export function pickProvenance(source: MergeProvenance): MergeProvenance {
  return {
    ...(source.mergedAt ? { mergedAt: source.mergedAt } : {}),
    ...(source.mergeCommit ? { mergeCommit: source.mergeCommit } : {}),
    ...(source.mergedBy ? { mergedBy: source.mergedBy } : {}),
  };
}

/** One Working Repository's delivery: a branch, or a reason no branch applies. */
export interface Delivery {
  /** Canonical `org/repository` of the Working Repository. */
  repository: string;
  branch?: string;
  /** True when the branch is protected and the developer opted into direct delivery. */
  direct?: boolean;
  /** Informational PR URL; the branch, not the PR, is what a change is delivered through. */
  pr?: string;
  merge?: MergeResult;
  notApplicable?: string;
}

export interface DeliveryRecord {
  version: 1;
  change: string;
  deliveries: Delivery[];
}

export type DeliveryPatch = Partial<Omit<Delivery, "repository">>;

/**
 * - `legacy`: no record (archived before Delivery Records, or past `mate artifact archive`)
 * - `unlinked`: a record without any delivery
 * - `not-applicable`: every delivery carries a not-applicable reason
 * - `merged`: every branch delivery is merged (the rest not applicable)
 * - `dropped`: some branch was closed without merging
 * - `waiting`: some branch has no merge result yet, or is still open, or a scoped
 *   repository has no delivery recorded
 */
export type DeliveryStatus =
  | "legacy"
  | "unlinked"
  | "not-applicable"
  | "merged"
  | "dropped"
  | "waiting";

export interface DeliverySettlement {
  status: DeliveryStatus;
  /** Repositories whose delivery keeps the change from being publishable. */
  unsettled: string[];
  /** Scoped repositories without any delivery, branch or not-applicable; a subset of `unsettled`. */
  missing: string[];
  /** Recorded repositories matching none of the change's scopes; empty when it has none. */
  unscoped: UnscopedDelivery[];
}

export interface UnscopedDelivery {
  repository: string;
  /** The scoped spelling it most likely means, when one is obvious. */
  closest?: string;
}

/**
 * Whether an archive with this status may be published; anything else is held back. A
 * `legacy` archive (made before Delivery Records) publishes, with a warning that its merge
 * was not checked.
 */
export function isPublishable(status: DeliveryStatus): boolean {
  return status === "merged" || status === "not-applicable" || status === "legacy";
}

/** The warning a `legacy` archive publishes with. */
export function legacyDeliveryWarning(anchorName: string): string {
  return `${anchorName} has no delivery.yaml, so its merge was not checked; publishing it as a legacy archive.`;
}

export function defaultDeliveryBranch(change: string): string {
  return `change/${change}`;
}

export function unlinkedRecord(change: string): DeliveryRecord {
  return { version: 1, change, deliveries: [] };
}

/** GitHub slugs are case-insensitive, so `Acme/Api` and `acme/api` name one repository. */
export function sameRepository(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function findDelivery(record: DeliveryRecord, repository: string): Delivery | undefined {
  return record.deliveries.find((entry) => sameRepository(entry.repository, repository));
}

/**
 * Applies `patch` to the repository's delivery, creating it when absent; an existing
 * delivery keeps its spelling of the repository. A branch and a not-applicable reason
 * exclude each other, and a new branch or a switch between direct and PR delivery drops
 * the previous merge result and PR, which described a different delivery; a different PR
 * drops the merge result.
 */
export function upsertDelivery(
  record: DeliveryRecord,
  requested: string,
  patch: DeliveryPatch,
): DeliveryRecord {
  const existing = findDelivery(record, requested);
  const repository = existing?.repository ?? requested;
  let next: Delivery = { ...existing, repository };
  if (patch.notApplicable !== undefined) {
    next = { repository, notApplicable: patch.notApplicable };
  } else {
    const newBranch = patch.branch !== undefined && patch.branch !== next.branch;
    const newMode = patch.direct !== undefined && patch.direct !== Boolean(next.direct);
    if (newBranch || newMode) {
      next = { repository, branch: patch.branch ?? next.branch };
    }
    if (patch.direct !== undefined) next.direct = patch.direct;
    if (patch.pr !== undefined && patch.pr !== next.pr) {
      delete next.merge;
      next.pr = patch.pr;
    }
    if (patch.merge !== undefined) next.merge = patch.merge;
    if (next.direct === false) delete next.direct;
  }
  const deliveries = existing
    ? record.deliveries.map((entry) => (entry === existing ? next : entry))
    : [...record.deliveries, next];
  return { ...record, deliveries };
}

/**
 * Settles a record against the repositories the change is scoped to: each needs its own
 * delivery, so linking only one repository of a cross-repository change settles nothing.
 */
export function settleDelivery(
  record: DeliveryRecord | null,
  scoped: readonly string[] = [],
): DeliverySettlement {
  if (!record) return { status: "legacy", unsettled: [], missing: [], unscoped: [] };
  const missing = scoped.filter((repository) => !findDelivery(record, repository));
  const unscoped = unscopedDeliveries(record, scoped);
  if (record.deliveries.length === 0) {
    return { status: "unlinked", unsettled: missing, missing, unscoped };
  }
  const branches = record.deliveries.filter((entry) => entry.notApplicable === undefined);
  const unsettled = [
    ...branches.filter((entry) => entry.merge?.state !== "merged").map((entry) => entry.repository),
    ...missing,
  ];
  if (unsettled.length === 0) {
    const status = branches.length === 0 ? "not-applicable" : "merged";
    return { status, unsettled, missing, unscoped };
  }
  const dropped = branches.some((entry) => entry.merge?.state === "closed-unmerged");
  return { status: dropped ? "dropped" : "waiting", unsettled, missing, unscoped };
}

function unscopedDeliveries(record: DeliveryRecord, scoped: readonly string[]): UnscopedDelivery[] {
  if (scoped.length === 0) return [];
  return record.deliveries
    .filter((entry) => !scoped.some((repository) => sameRepository(repository, entry.repository)))
    .map((entry) => {
      const closest = scoped.find((repository) => likelySame(repository, entry.repository));
      return closest ? { repository: entry.repository, closest } : { repository: entry.repository };
    });
}

/** Same last segment; this also covers one path being a suffix of the other (a dropped namespace). */
function likelySame(a: string, b: string): boolean {
  return a.toLowerCase().split("/").at(-1) === b.toLowerCase().split("/").at(-1);
}

function malformed(file: string, reason: string): Error {
  return new Error(`${file}: malformed ${DELIVERY_FILE}: ${reason}`);
}

function optionalString(value: unknown, file: string, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw malformed(file, `${field} must be a string`);
  return value;
}

const MERGE_STATES: readonly MergeState[] = ["merged", "open", "closed-unmerged"];
const MERGE_SOURCES: readonly MergeSource[] = ["forge", "user"];

function parseMerge(value: unknown, file: string): MergeResult | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw malformed(file, "merge must be a mapping");
  const merge = value as Record<string, unknown>;
  if (!MERGE_STATES.includes(merge.state as MergeState)) {
    throw malformed(file, `merge.state must be one of ${MERGE_STATES.join(", ")}`);
  }
  if (!MERGE_SOURCES.includes(merge.source as MergeSource)) {
    throw malformed(file, `merge.source must be one of ${MERGE_SOURCES.join(", ")}`);
  }
  const result: MergeResult = {
    state: merge.state as MergeState,
    source: merge.source as MergeSource,
    checkedAt: optionalString(merge.checkedAt, file, "merge.checkedAt") ?? "",
  };
  for (const key of ["mergedAt", "mergeCommit", "mergedBy"] as const) {
    const field = optionalString(merge[key], file, `merge.${key}`);
    if (field !== undefined) result[key] = field;
  }
  return result;
}

function parseDelivery(value: unknown, file: string): Delivery {
  if (!value || typeof value !== "object") throw malformed(file, "a delivery must be a mapping");
  const entry = value as Record<string, unknown>;
  const repository = optionalString(entry.repository, file, "repository");
  if (!repository) throw malformed(file, "every delivery names its repository");
  const delivery: Delivery = { repository };
  const branch = optionalString(entry.branch, file, "branch");
  const pr = optionalString(entry.pr, file, "pr");
  const notApplicable = optionalString(entry.notApplicable, file, "notApplicable");
  if (branch !== undefined) delivery.branch = branch;
  if (entry.direct === true) delivery.direct = true;
  if (pr !== undefined) delivery.pr = pr;
  const merge = parseMerge(entry.merge, file);
  if (merge) delivery.merge = merge;
  if (notApplicable !== undefined) delivery.notApplicable = notApplicable;
  return delivery;
}

/**
 * Reads `delivery.yaml` from a change directory, active or archived. Null means no file:
 * a legacy change. A file that exists but cannot be understood throws, so a damaged
 * record is never mistaken for a legacy archive and published past the merge gate.
 */
export async function readDeliveryRecord(changeDir: string): Promise<DeliveryRecord | null> {
  const file = path.join(changeDir, DELIVERY_FILE);
  let source: string;
  try {
    source = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    throw malformed(file, errorMessage(error));
  }
  if (!parsed || typeof parsed !== "object") throw malformed(file, "not a mapping");
  const document = parsed as Record<string, unknown>;
  const deliveries = document.deliveries ?? [];
  if (!Array.isArray(deliveries)) throw malformed(file, "deliveries must be a list");
  return {
    version: 1,
    change:
      optionalString(document.change, file, "change") ?? changeNameOf(path.basename(changeDir)),
    deliveries: deliveries.map((entry) => parseDelivery(entry, file)),
  };
}

/**
 * The change's record, or an unlinked one when none was written yet. The name comes from
 * `change`, not the file, so a renamed change's record follows its directory.
 */
export async function readOrUnlinkedRecord(
  changeDir: string,
  change: string,
): Promise<DeliveryRecord> {
  const name = changeNameOf(change);
  const record = await readDeliveryRecord(changeDir);
  return record ? { ...record, change: name } : unlinkedRecord(name);
}

/** A change's record with its settlement; `error` names a record that exists but cannot be read. */
export interface DeliveryState extends DeliverySettlement {
  record: DeliveryRecord | null;
  error?: string;
}

/** The change's settlement against its own scopes; see {@link settleDelivery}. */
export async function settleChangeDir(
  changeDir: string,
  record: DeliveryRecord | null,
): Promise<DeliverySettlement> {
  return settleDelivery(record, await scopedRepositories(changeDir));
}

/**
 * Like {@link readDeliveryRecord}, settled against the change's scopes; a damaged record is
 * reported as `unlinked` with its error.
 */
export async function readDeliveryState(changeDir: string): Promise<DeliveryState> {
  try {
    const record = await readDeliveryRecord(changeDir);
    return { ...(await settleChangeDir(changeDir, record)), record };
  } catch (error) {
    return {
      status: "unlinked",
      unsettled: [],
      missing: [],
      unscoped: [],
      record: null,
      error: errorMessage(error),
    };
  }
}

export async function writeDeliveryRecord(
  changeDir: string,
  record: DeliveryRecord,
): Promise<void> {
  await fs.writeFile(path.join(changeDir, DELIVERY_FILE), stringify(record), "utf8");
}
