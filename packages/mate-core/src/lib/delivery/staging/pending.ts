import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import { isChangeName } from "../../change-layout";
import { scopedRepositories } from "../../openspec-scopes";
import { FRAMEWORK_NAME } from "../../../framework";
import {
  companionGit,
  LITERAL_PATHSPECS,
  nulPaths,
  outputLines,
  type CompanionGit,
} from "../../../runtime/companion-git";
import { readSubmittedFolders } from "../../../runtime/companion-git-state";
import { isWithin } from "../../../runtime/physical-path";
import {
  inboxText,
  isSubmittedName,
  matchingArchive,
  sameTextBesidesLineEndings,
  submitters,
} from "../../../runtime/pending-records";
import { blobsAt } from "../../../runtime/submitted-arrivals";
import { errorMessage } from "../../../runtime/error-message";
import type { DeliveryEnvironment } from "../environment";
import { declaredDependencies } from "../overlap";
import {
  findDelivery,
  isPublishable,
  readDeliveryState,
  sameRepository,
  settleDelivery,
  upsertDelivery,
  type DeliveryBlock,
  type DeliveryRecord,
  type DeliveryState,
  type MergeSource,
} from "../record";
import type { ArtifactType, StalePart } from "./artifact-type";
import { findLinkedMerges, settleable, type UncheckedDelivery } from "./linked-merges";
import type { DeltaFailure } from "./replay";
import { deliveryGroupFor } from "./naming";
import {
  defaultRef,
  fetchPendingBranches,
  lastFetchedAt,
  mapLimited,
  pendingRef,
  recordsAt,
  stagingRemote,
  type StagingRemote,
  type TrailerRecord,
} from "./refs";
import { defaultArtifactType } from "./registry";

/** A change submitted on the pending branch, read from its folder there. */
export interface SubmittedChange {
  name: string;
  /** Its Delivery Group. */
  group: string;
  /** Companion-relative source folder. */
  path: string;
  /** Its Delivery Record, settled against its scopes. */
  delivery: DeliveryState;
  /** The repositories it is scoped to. */
  scoped: string[];
  blocked?: DeliveryBlock;
  specBase?: string;
  /** Change names it declares in `dependsOn`. */
  dependsOn: string[];
  /** The parts it rewrites or removes, as its type reads them; empty for a type that cannot. */
  touches: StalePart[];
}

/** Concurrent folders read at once; each runs a few Git processes. */
const READ_CONCURRENCY = 4;

/** Folders listed by one `git ls-tree`, which keeps its arguments far below the system's limit. */
const LIST_CHUNK = 200;

/** Files written at once. */
const WRITE_CONCURRENCY = 16;

/** Companion-relative source folder of change `name`. */
export function sourcePathOf(type: ArtifactType, name: string): string {
  return `${type.source}/${name}`;
}

/** Change names with a source folder at `ref`, the archive folder left out. */
async function sourceNamesAt(
  git: CompanionGit,
  ref: string,
  type: ArtifactType,
): Promise<string[]> {
  const listed = await git.run([
    "ls-tree",
    "-d",
    "-z",
    "--name-only",
    "--end-of-options",
    ref,
    "--",
    `${type.source}/`,
  ]);
  if (listed.status !== 0) return [];
  return nulPaths(listed.stdout)
    .filter((entry) => entry !== type.archiveRoot)
    .map((entry) => path.posix.basename(entry))
    .filter((name) => isChangeName(name) && isSubmittedName(name));
}

/** Submit orders by commit and source folder: a commit's history never changes. */
const submitOrders = new Map<string, string[]>();

/** Orders kept; a run reads a handful of inbox tips. */
const SUBMIT_ORDERS_KEPT = 8;

/**
 * Folder names below the source in the order a commit first added them at `ref`. The walk reads
 * the inbox's whole history, so it runs once per inbox tip in a process.
 */
async function submitOrder(git: CompanionGit, ref: string, type: ArtifactType): Promise<string[]> {
  const tip = await git.run(["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`]);
  const key = tip.status === 0 && tip.stdout.trim() ? `${tip.stdout.trim()}\0${type.source}` : null;
  const known = key === null ? undefined : submitOrders.get(key);
  if (known) return known;
  const order = await walkSubmitOrder(git, ref, type);
  if (key !== null && order !== null) {
    if (submitOrders.size >= SUBMIT_ORDERS_KEPT) {
      submitOrders.delete(submitOrders.keys().next().value!);
    }
    submitOrders.set(key, order);
  }
  return order ?? [];
}

/** {@link submitOrder}, read from Git; null when the walk fails. */
async function walkSubmitOrder(
  git: CompanionGit,
  ref: string,
  type: ArtifactType,
): Promise<string[] | null> {
  const log = await git.run([
    "log",
    "--reverse",
    "--diff-filter=A",
    "--format=",
    "--name-only",
    "-z",
    "--end-of-options",
    ref,
    "--",
    `${type.source}/`,
  ]);
  if (log.status !== 0) return null;
  const prefix = `${type.source}/`;
  const order: string[] = [];
  for (const file of nulPaths(log.stdout)) {
    const name = file.trim().slice(prefix.length).split("/")[0];
    if (file.trim().startsWith(prefix) && name && !order.includes(name)) order.push(name);
  }
  return order;
}

/**
 * Writes the Delivery Record and Markdown files of the change folders `names` at `ref` into one
 * folder each below `scratch`, with one listing per {@link LIST_CHUNK} folders and one batched
 * read, so the number of Git processes does not grow with the files. Contents are decoded as
 * text. A folder holding a path that would leave it (a crafted tree) is left out.
 */
async function materializeChanges(
  git: CompanionGit,
  ref: string,
  type: ArtifactType,
  names: readonly string[],
  scratch: string,
): Promise<void> {
  const files: { name: string; id: string; target: string }[] = [];
  const unsafe = new Set<string>();
  for (let at = 0; at < names.length; at += LIST_CHUNK) {
    const folders = names.slice(at, at + LIST_CHUNK).map((name) => `${sourcePathOf(type, name)}/`);
    // oxlint-disable-next-line no-await-in-loop -- one listing per chunk, in order
    const listed = await git.run([
      "ls-tree",
      "-r",
      "-z",
      "--end-of-options",
      ref,
      "--",
      ...folders,
    ]);
    if (listed.status !== 0) continue;
    for (const entry of nulPaths(listed.stdout)) {
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const [, kind, id] = entry.slice(0, tab).split(" ");
      const [name, ...rest] = path.posix.relative(type.source, entry.slice(tab + 1)).split("/");
      const relative = rest.join("/");
      if (kind !== "blob" || !id || !name) continue;
      if (relative !== type.deliveryFile && !relative.endsWith(".md")) continue;
      const dir = path.join(scratch, name);
      const target = path.join(dir, ...rest);
      if (target === dir || !isWithin(target, dir)) unsafe.add(name);
      else files.push({ name, id, target });
    }
  }
  const blobs = await git.readBlobs([...new Set(files.map((file) => file.id))]);
  if (!blobs) return;
  await mapLimited(
    files.filter((file) => !unsafe.has(file.name)),
    WRITE_CONCURRENCY,
    async ({ id, target }) => {
      const text = blobs.get(id);
      if (text === undefined) return;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text);
    },
  );
}

/**
 * The changes of `type` submitted at `ref` (`state: submitted` in their Delivery Record), in
 * submit order, then by name; with `only`, just those of that name. Only each folder's Delivery
 * Record and Markdown files are read, into a scratch folder below `tmpRoot` that is removed
 * afterwards.
 */
export async function submittedAt(
  git: CompanionGit,
  ref: string,
  type: ArtifactType,
  tmpRoot?: string,
  only?: readonly string[],
): Promise<SubmittedChange[]> {
  const names = (await sourceNamesAt(git, ref, type)).filter(
    (name) => only === undefined || only.includes(name),
  );
  if (names.length === 0) return [];
  const scratch = await fs.mkdtemp(
    path.join(tmpRoot ?? os.tmpdir(), `${FRAMEWORK_NAME}-submitted-`),
  );
  try {
    await materializeChanges(git, ref, type, names, scratch);
    const read = await mapLimited(names, READ_CONCURRENCY, async (name) => {
      const dir = path.join(scratch, name);
      const delivery = await readDeliveryState(dir);
      if (delivery.record?.state !== "submitted") return null;
      const { record } = delivery;
      const scoped = await scopedRepositories(dir);
      return {
        name,
        group: deliveryGroupFor(name, record, scoped).group,
        path: sourcePathOf(type, name),
        delivery,
        scoped,
        ...(record.blocked ? { blocked: record.blocked } : {}),
        ...(record.specBase ? { specBase: record.specBase } : {}),
        dependsOn: await declaredDependencies(dir),
        touches: (await type.touches?.(dir)) ?? [],
      } satisfies SubmittedChange;
    });
    const found = read.filter((entry): entry is SubmittedChange => entry !== null);
    // One change needs no order.
    const order = found.length > 1 ? await submitOrder(git, ref, type) : [];
    const rank = (name: string): number => {
      const at = order.indexOf(name);
      return at === -1 ? order.length : at;
    };
    return found.toSorted((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/** Blob ids by path relative to `prefix` at `ref`, the delivery file left out. */
async function contentAt(
  git: CompanionGit,
  ref: string,
  prefix: string,
  type: ArtifactType,
): Promise<Map<string, string>> {
  const blobs = await blobsAt(git, ref, prefix);
  blobs.delete(type.deliveryFile);
  return blobs;
}

/**
 * The record on `defaultRef` that change `name` at `pendingRef` was published as: an archive of
 * that name holding the same files, line endings and its Delivery Record aside (publication
 * settles it). Null while unpublished. `records` are those on `defaultRef`, when the caller
 * listed them with {@link recordsAt}.
 */
export async function publishedAs(
  git: CompanionGit,
  defaultTip: string,
  pendingTip: string,
  type: ArtifactType,
  name: string,
  records?: readonly TrailerRecord[],
): Promise<string | null> {
  const named = (records ?? (await recordsAt(git, defaultTip, type))).filter(
    (record) => type.recordName(record.id) === name,
  );
  if (named.length === 0) return null;
  const { archiveRoot } = type;
  if (archiveRoot === undefined) return publishedByTrailer(git, pendingTip, type, name, named);
  return matchingArchive(
    named.map((record) => record.id),
    await contentAt(git, pendingTip, sourcePathOf(type, name), type),
    (record) => contentAt(git, defaultTip, `${archiveRoot}/${record}`, type),
    async (source, archived) => {
      const texts = await git.readBlobs([source, archived]);
      const [mine, theirs] = [texts?.get(source), texts?.get(archived)];
      return mine !== undefined && theirs !== undefined && sameTextBesidesLineEndings(mine, theirs);
    },
  );
}

/** The commit on `ref` that last changed the folder `folder`, its Delivery Record aside. */
async function folderWrittenBy(
  git: CompanionGit,
  ref: string,
  folder: string,
  type: Pick<ArtifactType, "deliveryFile">,
): Promise<string | null> {
  const written = await git.run([
    "log",
    "-1",
    "--format=%H",
    "--end-of-options",
    ref,
    "--",
    `:(literal)${folder}/`,
    `:(exclude,literal)${folder}/${type.deliveryFile}`,
  ]);
  return written.status === 0 ? (outputLines(written.stdout)[0] ?? null) : null;
}

/**
 * {@link publishedAs} for a type that keeps no archive: the newest of `records`, those of that
 * name, published from an inbox commit that already held the folder as `pendingTip` holds it.
 * Ancestry, not commit dates: submitter and publisher clocks may disagree. A later change of
 * the same name was written after that commit, so it does not count.
 */
async function publishedByTrailer(
  git: CompanionGit,
  pendingTip: string,
  type: ArtifactType,
  name: string,
  records: readonly TrailerRecord[],
): Promise<string | null> {
  const written = await folderWrittenBy(git, pendingTip, sourcePathOf(type, name), type);
  if (written === null) return null;
  for (const record of records) {
    if (record.inbox === null) continue;
    // oxlint-disable-next-line no-await-in-loop -- newest first, usually the first
    const held = await git.run(["merge-base", "--is-ancestor", written, record.inbox]);
    if (held.status === 0) return record.id;
  }
  return null;
}

/** How far ahead of this clock an inbox commit's date may be and still date a delta. */
const CLOCK_TOLERANCE_S = 5 * 60;

/**
 * The commit a submitted change's delta was written against: its `specBase` when the default
 * branch holds it, else the default tip when the pending branch last changed its folder, at
 * submit or resolution, by that commit's date; edits of its Delivery Record alone (a settlement,
 * a block) do not count. Null when neither is known, or the date is ahead of this clock.
 */
export async function deltaBase(
  git: CompanionGit,
  defaultTip: string,
  pendingTip: string,
  change: Pick<SubmittedChange, "path" | "specBase">,
  type: Pick<ArtifactType, "deliveryFile">,
): Promise<string | null> {
  if (change.specBase) {
    const held = await git.run(["merge-base", "--is-ancestor", change.specBase, defaultTip]);
    if (held.status === 0) return change.specBase;
  }
  const written = await git.run([
    "log",
    "-1",
    "--format=%ct",
    "--end-of-options",
    pendingTip,
    "--",
    // Literal: a change name is no glob pattern.
    `:(literal)${change.path}/`,
    `:(exclude,literal)${change.path}/${type.deliveryFile}`,
  ]);
  const at = outputLines(written.stdout)[0];
  if (written.status !== 0 || !at) return null;
  // A date ahead of this clock would name the current tip, and nothing would be stale.
  if (!(Number(at) <= Date.now() / 1000 + CLOCK_TOLERANCE_S)) return null;
  const tip = await git.run([
    "rev-list",
    "-1",
    "--first-parent",
    `--before=${at}`,
    "--end-of-options",
    defaultTip,
  ]);
  return tip.status === 0 ? (outputLines(tip.stdout)[0] ?? null) : null;
}

/** Bound on the stale parts one scan collects. */
export const STALE_SCAN_LIMIT = 50;

/**
 * Every part the change at `sourcePath` in `ref` changes that changed between `base` and `tip`,
 * up to {@link STALE_SCAN_LIMIT}; none for a type without a stale check.
 */
export async function staleParts(
  type: Pick<ArtifactType, "stale">,
  git: CompanionGit,
  ref: string,
  sourcePath: string,
  base: string,
  tip: string,
): Promise<DeltaFailure[]> {
  const found: DeltaFailure[] = [];
  while (type.stale && found.length < STALE_SCAN_LIMIT) {
    // oxlint-disable-next-line no-await-in-loop -- each call skips what the earlier ones found
    const next = await type.stale(git, ref, sourcePath, base, tip, found);
    if (!next) break;
    found.push(next);
  }
  return found;
}

/**
 * `changes` ordered so each comes after the ones it declares in `dependsOn` among them, else in
 * their given order. A cycle keeps the given order for its members.
 */
export function orderByDependencies<T extends { name: string; dependsOn: readonly string[] }>(
  changes: readonly T[],
): T[] {
  const ordered: T[] = [];
  const visiting = new Set<string>();
  const visit = (change: T): void => {
    if (ordered.includes(change) || visiting.has(change.name)) return;
    visiting.add(change.name);
    for (const dependency of change.dependsOn) {
      const found = changes.find((entry) => entry.name === dependency);
      if (found) visit(found);
    }
    ordered.push(change);
  };
  for (const change of changes) visit(change);
  return ordered;
}

/**
 * A final merge result a submitted change records, with who recorded it. The inbox takes any
 * teammate's push and Git's author is what the pusher wrote, so this says whose claim a
 * publication rests on; it proves nothing.
 */
export interface MergeClaim {
  repository: string;
  state: "merged" | "dropped";
  /** `git`: a checkout found the merge; `user`: someone answered. */
  source: MergeSource;
  /** Who committed it to the inbox; absent when Git cannot say or it is not committed yet. */
  recordedBy?: string;
  /** Committed with your Git email, or recorded in this run. */
  yours: boolean;
}

/** Inbox commits of one Delivery Record read for {@link mergeClaims}. */
const CLAIM_HISTORY = 50;

/** What identifies a recorded merge result of `repository` in a Delivery Record's YAML. */
function claimKey(yaml: string | undefined, repository: string): string | null {
  if (yaml === undefined) return null;
  try {
    const deliveries = (parse(yaml) as { deliveries?: unknown } | null)?.deliveries;
    for (const entry of Array.isArray(deliveries) ? deliveries : []) {
      const delivery = (entry ?? {}) as { repository?: unknown; merge?: unknown };
      if (typeof delivery.repository !== "string") continue;
      if (!sameRepository(delivery.repository, repository)) continue;
      const merge = (delivery.merge ?? null) as Record<string, unknown> | null;
      return merge && typeof merge === "object"
        ? JSON.stringify([merge.state, merge.source, merge.checkedAt, merge.mergeCommit])
        : null;
    }
  } catch {
    // An unreadable earlier version recorded nothing.
  }
  return null;
}

/**
 * The final merge results `record` holds for the change at `changePath`, each with the author
 * of the inbox commit at or before `ref` that first recorded it as it reads now: a later commit
 * that only blocks or resolves the change keeps the claim its recorder's. A result `ref` does
 * not hold yet was recorded in this run and is `yours`.
 */
export async function mergeClaims(
  git: CompanionGit,
  ref: string,
  changePath: string,
  record: DeliveryRecord | null,
  type: Pick<ArtifactType, "deliveryFile">,
): Promise<MergeClaim[]> {
  const settled = (record?.deliveries ?? []).filter(
    (delivery) => delivery.merge !== undefined && delivery.merge.state !== "open",
  );
  if (settled.length === 0) return [];
  const file = `${changePath}/${type.deliveryFile}`;
  const [log, configured] = await Promise.all([
    git.run([
      ...LITERAL_PATHSPECS,
      "log",
      `-n${CLAIM_HISTORY}`,
      "--format=%H%x02%an%x02%ae",
      "--end-of-options",
      ref,
      "--",
      file,
    ]),
    git.run(["config", "--get", "user.email"]),
  ]);
  const commits = (log.status === 0 ? outputLines(log.stdout) : []).map((line) => {
    const [id = "", name = "", email = ""] = line.split("\x02");
    return { spec: `${id}:${file}`, name, email };
  });
  const texts = await git.readBlobs(commits.map((commit) => commit.spec));
  // Without the history nobody is named, and nothing counts as yours.
  const known = log.status === 0 && texts !== null;
  const mine = configured.status === 0 ? configured.stdout.trim().toLowerCase() : "";
  return settled.map((delivery) => {
    const merge = delivery.merge!;
    const key = JSON.stringify([merge.state, merge.source, merge.checkedAt, merge.mergeCommit]);
    let recorder: (typeof commits)[number] | undefined;
    for (const commit of commits) {
      if (claimKey(texts?.get(commit.spec), delivery.repository) !== key) break;
      recorder = commit;
    }
    return {
      repository: delivery.repository,
      state: merge.state as MergeClaim["state"],
      source: merge.source,
      ...(recorder?.name ? { recordedBy: recorder.name } : {}),
      // Not at `ref` when its newest commit lacks it: recorded in this run.
      yours:
        known && (recorder === undefined || (mine !== "" && recorder.email.toLowerCase() === mine)),
    };
  });
}

/** True for a claim someone else answered: no checkout found the merge, and it is not yours. */
export function isOthersAnswer(claim: MergeClaim): boolean {
  return !claim.yours && claim.source !== "git";
}

/** Why a submitted change's delivery keeps its group unpublished, or null when it may publish. */
export function deliveryHold(change: SubmittedChange): string | null {
  const { delivery } = change;
  if (delivery.error) return `${change.name} (unreadable delivery: ${inboxText(delivery.error)})`;
  if (isPublishable(delivery.status) && delivery.missing.length === 0) return null;
  const waiting =
    delivery.unsettled.length > 0 ? `: ${delivery.unsettled.map(inboxText).join(", ")}` : "";
  return `${change.name} (${delivery.status}${waiting})`;
}

/** A Delivery Group of submitted changes, in publication order. */
export interface SubmittedGroup {
  group: string;
  changes: SubmittedChange[];
}

/** `submitted` by Delivery Group, groups in the submit order of their first change. */
export function groupsOf(submitted: readonly SubmittedChange[]): SubmittedGroup[] {
  const groups: SubmittedGroup[] = [];
  for (const change of submitted) {
    const group = groups.find((entry) => entry.group === change.group);
    if (group) group.changes.push(change);
    else groups.push({ group: change.group, changes: [change] });
  }
  return groups.map((entry) => ({ ...entry, changes: orderByDependencies(entry.changes) }));
}

/** The changes of other groups that `group`'s changes depend on and that are still submitted. */
export function unpublishedDependencies(
  group: SubmittedGroup,
  submitted: readonly SubmittedChange[],
): SubmittedChange[] {
  const own = new Set(group.changes.map((change) => change.name));
  const names = new Set(
    group.changes.flatMap((change) => change.dependsOn).filter((name) => !own.has(name)),
  );
  return submitted.filter((change) => names.has(change.name));
}

/**
 * Groups ordered so a group comes after the groups its changes depend on, else in submit
 * order; `publish --all` publishes them in this order.
 */
export function publicationOrder(
  groups: readonly SubmittedGroup[],
  submitted: readonly SubmittedChange[],
): SubmittedGroup[] {
  const withDependencies = groups.map((group) => ({
    group,
    name: group.group,
    dependsOn: [
      ...new Set(unpublishedDependencies(group, submitted).map((change) => change.group)),
    ],
  }));
  return orderByDependencies(withDependencies).map((entry) => entry.group);
}

/**
 * Whether every group's changes may publish: each delivery settled, and each group its changes
 * depend on publishable too, so both publish in one run. Keyed by group.
 */
function publishableGroups(
  groups: readonly SubmittedGroup[],
  submitted: readonly SubmittedChange[],
): Map<string, boolean> {
  const verdicts = new Map<string, boolean>();
  const visit = (group: SubmittedGroup, seen: ReadonlySet<string>): boolean => {
    const known = verdicts.get(group.group);
    if (known !== undefined) return known;
    if (seen.has(group.group)) return false;
    const next = new Set([...seen, group.group]);
    const verdict =
      group.changes.every((change) => deliveryHold(change) === null) &&
      [...new Set(unpublishedDependencies(group, submitted).map((change) => change.group))].every(
        (name) => {
          const dependency = groups.find((entry) => entry.group === name);
          return dependency !== undefined && visit(dependency, next);
        },
      );
    verdicts.set(group.group, verdict);
    return verdict;
  };
  for (const group of groups) visit(group, new Set());
  return verdicts;
}

/** A submitted change as `mate artifact pending` lists it. */
export interface SubmittedChangeView {
  name: string;
  delivery: DeliveryState;
  blocked?: DeliveryBlock;
  dependsOn: string[];
  /** The parts it rewrites or removes; see {@link SubmittedChange.touches}. */
  touches: StalePart[];
  /** Its folder on the pending branch, readable as `git show <ref>:<path>/<file>`. */
  path: string;
  /** `yours`: committed with your Git email or submitted from this checkout; else `others`. */
  origin: "yours" | "others";
  /** Who submitted it, by the pending branch's history; absent when Git cannot say. */
  author?: string;
  /** Its final merge results on the pending branch and who recorded each; see {@link MergeClaim}. */
  merges: MergeClaim[];
  /** Deliveries whose merge this run's check found and nothing recorded yet; absent when none. */
  found?: FoundDelivery[];
}

export interface SubmittedGroupView {
  group: string;
  changes: SubmittedChangeView[];
  /** A change of it records a block. */
  blocked: boolean;
  /** Every delivery is settled and no unpublishable group holds it; one selection publishes it. */
  publishable: boolean;
  /** Changes of other groups it depends on whose group cannot publish yet. */
  heldBy: string[];
  /**
   * Publishable only through a merge in `found`, of its own or of a dependency's group: publish
   * it with `--refresh`, which records that merge.
   */
  needsRefresh?: true;
}

/** A branch delivery of one repository. */
export interface FoundDelivery {
  repository: string;
  branch: string;
}

/** The local merge check of one discovery; see {@link DiscoverSubmittedOptions.checkMerges}. */
export interface MergeCheck {
  /** False when the check was not asked for or could not run. */
  ran: boolean;
  /** Linked deliveries not checked in time, or whose check failed; their stored state stands. */
  unchecked: (FoundDelivery & { change: string })[];
  /** Why the check, or some delivery's check, failed. */
  warning?: string;
}

/** `stale`: the fetch failed or was not attempted; the refs are the last fetched ones. */
export interface SubmittedDiscovery {
  pendingBranch: string | null;
  /** The pending branch's remote-tracking ref as last fetched; absent without an upstream. */
  ref?: string;
  fetchedAt: string | null;
  stale: boolean;
  error?: string;
  groups: SubmittedGroupView[];
  /** Present when the caller asked for the merge check. */
  mergeCheck?: MergeCheck;
}

/** `changes` at `ref` without those the default branch already archived. */
async function withoutPublished(
  git: CompanionGit,
  remote: StagingRemote,
  ref: string,
  type: ArtifactType,
  changes: SubmittedChange[],
): Promise<SubmittedChange[]> {
  const records = await recordsAt(git, defaultRef(remote), type);
  const published = await mapLimited(changes, READ_CONCURRENCY, (change) =>
    publishedAs(git, defaultRef(remote), ref, type, change.name, records),
  );
  return changes.filter((_, index) => published[index] === null);
}

export interface DiscoverSubmittedOptions {
  /** Fetch the default and pending branches first; otherwise use the last fetched refs. */
  fetch: boolean;
  git?: (cwd: string) => CompanionGit;
  tmpRoot?: string;
  type?: ArtifactType;
  /** Home of Mate's local companion state; `HOME` by default. */
  stateHome?: string;
  /**
   * Checks unsettled branch deliveries in the checkouts `environment` links, stopping every check
   * after `budgetMs`, and counts the merges Git proves without recording them. `environment` is
   * resolved only when such a delivery exists. Off when absent.
   */
  checkMerges?: { environment: () => Promise<DeliveryEnvironment>; budgetMs: number };
}

/** Bound on discovery's fetch and reads. */
const DISCOVERY_BUDGET_MS = 60_000;

function discoveryGit(cwd: string): CompanionGit {
  return companionGit(cwd, { prompt: "never", budgetMs: DISCOVERY_BUDGET_MS });
}

/**
 * The submitted changes on the companion's pending branch by Delivery Group, with each one's
 * delivery, block and origin. Read-only apart from the optional fetch; a failed fetch keeps the
 * last fetched state, marked stale.
 */
export async function discoverSubmitted(
  companionPath: string,
  options: DiscoverSubmittedOptions,
): Promise<SubmittedDiscovery> {
  const git = (options.git ?? discoveryGit)(companionPath);
  const remote = await stagingRemote(git);
  if (!remote) {
    return {
      pendingBranch: null,
      fetchedAt: null,
      stale: false,
      groups: [],
      ...(options.checkMerges ? { mergeCheck: { ran: false, unchecked: [] } } : {}),
    };
  }
  let stale = !options.fetch;
  let error: string | undefined;
  if (options.fetch) {
    const fetched = await fetchPendingBranches(git, remote);
    if ("error" in fetched) {
      stale = true;
      error = fetched.error;
    }
  }
  const type = options.type ?? defaultArtifactType();
  // Published, but the inbox was not emptied yet: no longer pending.
  const stored = await withoutPublished(
    git,
    remote,
    pendingRef(remote),
    type,
    await submittedAt(git, pendingRef(remote), type, options.tmpRoot),
  );
  const checked = options.checkMerges
    ? await withFoundMerges(stored, options.checkMerges)
    : { submitted: stored, found: new Map<string, FoundDelivery[]>(), mergeCheck: undefined };
  const { submitted, found, mergeCheck } = checked;
  const who = await submitters(
    companionPath,
    pendingRef(remote),
    submitted.map((change) => change.path),
    readSubmittedFolders(companionPath, options.stateHome),
  );
  const groups = groupsOf(submitted);
  const publishable = publishableGroups(groups, submitted);
  // A group publishable only through a found merge, its own or a dependency's, needs a refresh.
  const storedPublishable =
    found.size > 0 ? publishableGroups(groupsOf(stored), stored) : publishable;
  // Stored records only: a found merge is nobody's claim yet.
  const claims = await mapLimited(stored, READ_CONCURRENCY, (change) =>
    mergeClaims(git, pendingRef(remote), change.path, change.delivery.record, type),
  );
  const merges = new Map(stored.map((change, index) => [change.name, claims[index]!]));
  return {
    pendingBranch: remote.pendingBranch,
    ref: pendingRef(remote),
    fetchedAt: await lastFetchedAt(git),
    stale,
    ...(error ? { error } : {}),
    ...(mergeCheck ? { mergeCheck } : {}),
    groups: groups.map((group) => ({
      group: group.group,
      changes: group.changes.map((change) => {
        const submitter = who.get(change.path);
        return {
          name: change.name,
          delivery: change.delivery,
          ...(change.blocked ? { blocked: change.blocked } : {}),
          dependsOn: change.dependsOn,
          touches: change.touches,
          path: change.path,
          origin: submitter?.mine ? ("yours" as const) : ("others" as const),
          ...(submitter?.author ? { author: submitter.author } : {}),
          merges: merges.get(change.name) ?? [],
          ...(found.has(change.name) ? { found: found.get(change.name)! } : {}),
        };
      }),
      blocked: group.changes.some((change) => change.blocked !== undefined),
      publishable: publishable.get(group.group) === true,
      heldBy: unpublishedDependencies(group, submitted)
        .filter((change) => publishable.get(change.group) !== true)
        .map((change) => change.name),
      ...(publishable.get(group.group) === true && storedPublishable.get(group.group) !== true
        ? { needsRefresh: true as const }
        : {}),
    })),
  };
}

/**
 * `submitted` with each change settled as if the merges the local check proves were recorded,
 * and the deliveries found that way by change. Records nothing: `record` stays the stored one.
 */
async function withFoundMerges(
  submitted: SubmittedChange[],
  { environment, budgetMs }: NonNullable<DiscoverSubmittedOptions["checkMerges"]>,
): Promise<{
  submitted: SubmittedChange[];
  found: Map<string, FoundDelivery[]>;
  mergeCheck: MergeCheck;
}> {
  if (!submitted.some((change) => change.delivery.record?.deliveries.some(settleable))) {
    return { submitted, found: new Map(), mergeCheck: { ran: true, unchecked: [] } };
  }
  const unchecked: UncheckedDelivery[] = [];
  // Kills the checks' Git commands too, so the budget bounds the whole check.
  const signal = budgetMs > 0 ? AbortSignal.timeout(budgetMs) : AbortSignal.abort();
  let merges: Awaited<ReturnType<typeof findLinkedMerges>>;
  try {
    merges = await findLinkedMerges(await environment(), submitted, {
      signal,
      onUnchecked: (delivery) => unchecked.push(delivery),
    });
  } catch (error) {
    const warning = `could not run: ${errorMessage(error)}`;
    return { submitted, found: new Map(), mergeCheck: { ran: false, unchecked: [], warning } };
  }
  const found = new Map<string, FoundDelivery[]>();
  const next = submitted.map((change) => {
    let record = change.delivery.record;
    const applied: FoundDelivery[] = [];
    for (const { repository, branch, patch } of merges.get(change.name) ?? []) {
      const delivery = record && findDelivery(record, repository);
      if (!record || !delivery || delivery.branch !== branch || !settleable(delivery)) continue;
      record = upsertDelivery(record, repository, patch);
      applied.push({ repository: delivery.repository, branch });
    }
    if (applied.length === 0) return change;
    found.set(change.name, applied);
    return {
      ...change,
      delivery: { ...change.delivery, ...settleDelivery(record, change.scoped) },
    };
  });
  const failures = unchecked
    .filter((delivery) => delivery.error !== undefined)
    .map(
      (failure) =>
        `checking ${failure.branch} in ${failure.repository} failed: ${errorMessage(failure.error)}`,
    );
  return {
    submitted: next,
    found,
    mergeCheck: {
      ran: true,
      unchecked: unchecked.map(({ change, repository, branch }) => ({
        change,
        repository,
        branch,
      })),
      ...(failures.length > 0 ? { warning: failures.join("; ") } : {}),
    },
  };
}
