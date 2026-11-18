import fs from "node:fs/promises";
import path from "node:path";

import { isChangeName } from "../../change-layout";
import { pathIsDirectory } from "../../fs-utils";
import { scopedRepositories } from "../../openspec-scopes";
import {
  companionGit,
  describeGitFailure,
  LITERAL_PATHSPECS,
  nulPaths,
  type CompanionGit,
} from "../../../runtime/companion-git";
import {
  readSubmittedFolders,
  updateSubmittedFolders,
  type SubmittedFolder,
} from "../../../runtime/companion-git-state";
import { errorMessage } from "../../../runtime/error-message";
import { isSubmittedName } from "../../../runtime/pending-records";
import { isWithin } from "../../../runtime/physical-path";
import { contentDigest, folderDigest, ownFiles } from "../../../runtime/submitted-arrivals";
import type { PublicationSecretScan } from "../../../runtime/publication-secret-scan";
import type { SecretFinding } from "../../../runtime/secret-scan";
import {
  DELIVERY_FILE,
  findDelivery,
  isCommitId,
  readDeliveryRecord,
  readOrUnlinkedRecord,
  upsertDelivery,
  writeDeliveryRecord,
  type DeliveryRecord,
  type SubmissionState,
} from "../record";
import { isSettled } from "../refresh";
import { recordDir, sourceDir, type ArtifactType } from "./artifact-type";
import { deliveryGroupFor, type DeliveryGroupName } from "./naming";
import { sourcePathOf, staleParts, STALE_SCAN_LIMIT } from "./pending";
import { commitToPending } from "./pending-edit";
import {
  defaultRef,
  fetchPendingBranches,
  pendingPlace,
  pendingRef,
  stagingRemote,
  type StagingRemote,
} from "./refs";
import { defaultArtifactType } from "./registry";
import { linkedContentPaths } from "./worktree";

/** Bound on one submit or drop push, every fetch, command and push included. */
const SUBMIT_BUDGET_MS = 120_000;

export interface SubmitDeps {
  /** Git for one directory, network included. */
  git?: (cwd: string) => CompanionGit;
  /** The changes' artifact type; OpenSpec by default. */
  artifactType?: ArtifactType;
  /** Scans `paths` under `root` with the companion's policy; the publication scan by default. */
  scan?: (root: string, paths: string[], policyPath: string) => Promise<PublicationSecretScan>;
  newTransaction?: () => string;
  tmpRoot?: string;
  /** Home of Mate's local companion state; `HOME` by default. */
  stateHome?: string;
  now?: () => Date;
}

const defaultGit = (cwd: string): CompanionGit =>
  companionGit(cwd, { prompt: "never", budgetMs: SUBMIT_BUDGET_MS });

/** SHA-256 over a folder's relative file paths and contents; sync compares it later. */
export { folderDigest };

/** A change's state as its Delivery Record says; `active` without one or with a damaged one. */
export async function submissionState(changeDir: string): Promise<SubmissionState> {
  const record = await readDeliveryRecord(changeDir).catch(() => null);
  return record?.state ?? "active";
}

/** Writes `state` into change `name`'s Delivery Record, creating an unlinked one when absent. */
export async function writeSubmissionState(
  changeDir: string,
  name: string,
  state: SubmissionState,
): Promise<void> {
  const record = await readOrUnlinkedRecord(changeDir, name);
  await writeDeliveryRecord(changeDir, { ...record, state });
}

/** The Delivery Group of local change `name` after its Delivery Record. */
export async function groupOfChange(
  companionPath: string,
  name: string,
  type: ArtifactType = defaultArtifactType(),
): Promise<DeliveryGroupName> {
  const dir = sourceDir(companionPath, type, name);
  const record = await readDeliveryRecord(dir).catch(() => null);
  return deliveryGroupFor(name, record, await scopedRepositories(dir));
}

export interface LocalMember {
  name: string;
  state: SubmissionState;
  group: string;
}

/** Every local source folder of `type` with its state and Delivery Group, by name. */
export async function localMembers(
  companionPath: string,
  type: ArtifactType = defaultArtifactType(),
): Promise<LocalMember[]> {
  const root = path.join(companionPath, ...type.source.split("/"));
  const archive = recordDir(companionPath, type);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && isChangeName(entry.name))
    .map((entry) => entry.name)
    .filter((name) => path.join(root, name) !== archive)
    .toSorted();
  return Promise.all(
    names.map(async (name) => {
      const dir = sourceDir(companionPath, type, name);
      const record = await readDeliveryRecord(dir).catch(() => null);
      return {
        name,
        state: record?.state ?? "active",
        group: deliveryGroupFor(name, record, await scopedRepositories(dir)).group,
      };
    }),
  );
}

export type PendingFailure =
  | "no-remote"
  | "fetch-failed"
  | "secret"
  | "push-failed"
  /** The remote refused this user's push to the pending branch. */
  | "not-permitted"
  /** The pending branch kept moving through every rebuild. */
  | "conflict"
  | "failed";

export interface PendingCommit {
  status: "pushed" | "unchanged" | "failed";
  reason?: PendingFailure;
  /** The commit this run pushed. */
  commit: string | null;
  /** The branch submitted changes wait on, once known. */
  pendingBranch: string | null;
  secretFindings?: SecretFinding[];
  /** Why it failed, for `failed`. */
  detail?: string;
}

function failed(
  reason: PendingFailure,
  detail: string,
  remote: StagingRemote | null,
): PendingCommit {
  return {
    status: "failed",
    reason,
    commit: null,
    pendingBranch: remote?.pendingBranch ?? null,
    detail,
  };
}

/** Writes the change into the pending checkout `dir`; returns the paths it touched. */
type Stage = (dir: string, remote: StagingRemote) => Promise<string[]>;

/**
 * {@link commitToPending} as submit and drop report it: no commit when nothing changed, and a
 * thrown failure reported as `failed`.
 */
async function commitStaged(
  companionPath: string,
  subject: string,
  stage: Stage,
  deps: SubmitDeps,
): Promise<PendingCommit> {
  try {
    const result = await commitToPending(
      { companionPath, subject, edit: stage },
      { ...deps, git: deps.git ?? defaultGit },
    );
    const pendingBranch = result.remote?.pendingBranch ?? null;
    if (result.status === "pushed") {
      return { status: "pushed", commit: result.commit, pendingBranch };
    }
    if (result.status !== "failed") return { status: "unchanged", commit: null, pendingBranch };
    return {
      ...failed(
        result.reason === "commit-failed" ? "failed" : result.reason,
        result.detail,
        result.remote,
      ),
      ...(result.reason === "secret" ? { secretFindings: result.secretFindings } : {}),
    };
  } catch (error) {
    return failed("failed", errorMessage(error), null);
  }
}

/** `target` below `dir`, refused when it would leave `dir`. */
function within(dir: string, relative: string): string {
  const target = path.join(dir, ...relative.split("/"));
  if (target === dir || !isWithin(target, dir)) {
    throw new Error(`${relative} lies outside the companion`);
  }
  return target;
}

export interface GroupPush extends PendingCommit {
  group: string;
  /** The folders the commit carries, by change name. */
  changes: string[];
}

/**
 * The Delivery Record change `name` is pushed with: `state: submitted`, an earlier block
 * cleared, and a delta base the default branch holds, so publication can tell a requirement
 * changed since: the recorded one, or where it left the default branch when it is a local
 * commit, else `tip`, the fetched default tip. Written locally only once the push succeeded, so
 * a failed push leaves the record, its state included, as it was. Throws on a damaged record.
 */
async function preparedRecord(
  git: CompanionGit,
  changeDir: string,
  name: string,
  tip: string,
): Promise<DeliveryRecord> {
  const record = await readOrUnlinkedRecord(changeDir, name);
  let specBase = record.specBase ?? (isCommitId(tip) ? tip : undefined);
  if (record.specBase && isCommitId(record.specBase) && isCommitId(tip)) {
    const shared = await git.run(["merge-base", record.specBase, tip]);
    const commit = shared.stdout.trim();
    if (shared.status === 0 && isCommitId(commit)) specBase = commit;
  }
  const next: DeliveryRecord = { ...record, state: "submitted", ...(specBase ? { specBase } : {}) };
  delete next.blocked;
  return next;
}

/**
 * `record` with the final merge results `pending`, the same change's record on the pending
 * branch, holds for the same deliveries and `record` lacks: an answer or a merge recorded there
 * from another machine survives a resubmit.
 */
function withPendingSettlements(
  record: DeliveryRecord,
  pending: DeliveryRecord | null,
): DeliveryRecord {
  if (!pending) return record;
  let next = record;
  for (const delivery of record.deliveries) {
    if (!delivery.branch || isSettled(delivery)) continue;
    const settled = findDelivery(pending, delivery.repository);
    if (
      !settled?.merge ||
      !isSettled(settled) ||
      settled.branch !== delivery.branch ||
      Boolean(settled.direct) !== Boolean(delivery.direct)
    ) {
      continue;
    }
    next = upsertDelivery(next, delivery.repository, {
      ...(settled.pr ? { pr: settled.pr } : {}),
      ...(settled.head ? { head: settled.head } : {}),
      merge: settled.merge,
    });
  }
  return next;
}

/**
 * The files below the companion folder `relative` its own Git would add: tracked and untracked,
 * ignored ones left out. Throws on a symbolic link, submodule or nested repository, which would
 * stop every later temporary worktree of the pending branch, and on a folder with no such file.
 */
async function submittableFiles(
  git: CompanionGit,
  companionPath: string,
  relative: string,
): Promise<string[]> {
  const listed = await git.run([
    ...LITERAL_PATHSPECS,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    `${relative}/`,
  ]);
  if (listed.status !== 0) throw new Error(`git ls-files ${relative} failed`);
  const files: string[] = [];
  for (const file of new Set(nulPaths(listed.stdout))) {
    // An untracked nested repository is listed as its directory.
    const nested = file.endsWith("/");
    // oxlint-disable-next-line no-await-in-loop -- a handful of files per change
    const stat = nested ? null : await fs.lstat(path.join(companionPath, file)).catch(() => null);
    if (!nested && stat === null) continue;
    if (nested || !stat!.isFile()) {
      throw new Error(
        `${file.replace(/\/$/, "")} is a symbolic link, submodule or nested Git repository; Mate does not submit it. Remove it from ${relative} and submit again.`,
      );
    }
    files.push(file);
  }
  if (files.length === 0) {
    throw new Error(`${relative} holds no file Git would add; check the companion's .gitignore.`);
  }
  return files;
}

/**
 * The content of the regular file `file` below the companion, read without following a
 * symbolic link: a file swapped for a link after it was listed must not push what it points to.
 */
async function readSubmittable(
  companionPath: string,
  folder: string,
  file: string,
): Promise<Buffer> {
  const source = path.join(companionPath, ...file.split("/"));
  const parent = await fs.realpath(path.dirname(source));
  if (!isWithin(parent, await fs.realpath(path.join(companionPath, ...folder.split("/"))))) {
    throw new Error(`${file} lies outside ${folder}; Mate does not submit it.`);
  }
  const handle = await fs
    .open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    .catch((error: NodeJS.ErrnoException) => {
      throw error.code === "ELOOP"
        ? new Error(`${file} is a symbolic link; Mate does not submit it.`)
        : error;
    });
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(`${file} is no regular file; Mate does not submit it.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** {@link contentDigest} of `files` without the Delivery Record, which settlements and blocks rewrite. */
function contentOnly(files: readonly (readonly [string, Uint8Array])[]): string {
  return contentDigest(files.filter(([file]) => file !== DELIVERY_FILE));
}

/**
 * {@link contentOnly} of folder `relative` in the pending checkout `dir`; null when the pending
 * branch does not hold the folder.
 */
async function pendingContent(
  git: CompanionGit,
  dir: string,
  relative: string,
): Promise<string | null> {
  const files = await ownFiles(git, dir, relative);
  if (files === null) throw new Error(`git ls-files ${relative} failed`);
  if (files.length === 0) return null;
  return folderDigest(
    path.join(dir, ...relative.split("/")),
    files.filter((file) => file !== DELIVERY_FILE),
  );
}

export interface PushOptions {
  /** Changes of the push staged only when the pending branch does not hold their folder. */
  ifMissing?: readonly string[];
  /**
   * Changes submitted by name: one the pending branch records blocked is pushed again even
   * unchanged, and takes the default tip as delta base when {@link acceptsBlock} allows it.
   */
  acknowledge?: readonly string[];
}

/**
 * True when the change at `folder` in `ref`, a commit or tree of the pending checkout `work`,
 * has stale parts and overwrites none of the parts that changed between `base` and `tip`: its author, shown the
 * conflict, submitted it again, and what remains stale (a removal, a plain rename) replaces no
 * one's text. A part it would overwrite still needs `mate artifact resolve`.
 */
async function acceptsBlock(
  type: ArtifactType,
  work: CompanionGit,
  ref: string,
  folder: string,
  base: string,
  tip: string,
): Promise<boolean> {
  const stale = await staleParts(type, work, ref, folder, base, tip);
  // Nothing stale: the block has another cause, which a new base would not lift.
  return (
    stale.length > 0 &&
    stale.length < STALE_SCAN_LIMIT &&
    stale.every((part) => part.overwrites === false)
  );
}

/** {@link acceptsBlock} for the folder as staged in the pending checkout `work`. */
async function stagedAccepts(
  type: ArtifactType,
  work: CompanionGit,
  folder: string,
  base: string,
  tip: string,
): Promise<boolean> {
  await work.run([...LITERAL_PATHSPECS, "add", "-f", "-A", "--", folder]);
  const tree = (await work.run(["write-tree"])).stdout.trim();
  return isCommitId(tree) && acceptsBlock(type, work, tree, folder, base, tip);
}

/**
 * Pushes the local folders of `names`, changes of one Delivery Group, in one commit on the
 * pending branch, each with `state: submitted`, replacing their earlier copies there. Only files
 * the companion does not ignore are copied. A folder the pending branch holds with other content
 * than this checkout last submitted or took (a teammate resolved or revised it) is never
 * replaced: it stays as it is there when only the local Delivery Record differs, else the push
 * fails. A change of `options.acknowledge` the pending branch records blocked takes the default
 * tip as delta base when it overwrites no stale part. A final merge result the pending branch
 * records for a delivery, and the local record lacks, is kept. Only on success are the local records of the folders it carries set `submitted` and
 * each folder's digest recorded as submitted from this checkout. The checkout is not touched
 * otherwise.
 */
async function pushGroup(
  companionPath: string,
  group: string,
  names: readonly string[],
  deps: SubmitDeps = {},
  options: PushOptions = {},
): Promise<GroupPush> {
  const type = deps.artifactType ?? defaultArtifactType();
  const paths = names.map((name) => sourcePathOf(type, name));
  const gitFor = deps.git ?? defaultGit;
  const local = gitFor(companionPath);
  // Refused before any fetch, so nothing of the group is copied or pushed.
  const unnamed = names.filter((name) => !isSubmittedName(name));
  if (unnamed.length > 0) {
    const detail = `${unnamed.join(", ")} cannot be submitted under that name: a submitted change's name starts with a letter, digit or \`_\` and holds only those, \`.\` and \`-\`. Rename the change, then submit it.`;
    return { ...failed("failed", detail, null), group, changes: [...names] };
  }
  const listed: string[][] = [];
  try {
    for (const relative of paths) {
      // oxlint-disable-next-line no-await-in-loop -- one folder at a time
      listed.push(await submittableFiles(local, companionPath, relative));
    }
  } catch (error) {
    return { ...failed("failed", errorMessage(error), null), group, changes: [...names] };
  }
  const submitted = readSubmittedFolders(companionPath, deps.stateHome);
  // The digests of exactly the bytes pushed, so an edit made meanwhile counts as unsubmitted.
  const digests = new Map<string, Pick<SubmittedFolder, "digest" | "content">>();
  const records = new Map<string, DeliveryRecord>();
  const pushed = await commitStaged(
    companionPath,
    `chore(${type.name}): submit ${group}`,
    async (dir, remote) => {
      // A rebuilt attempt decides again on the new tip.
      digests.clear();
      records.clear();
      const work = gitFor(dir);
      const tip = await local.run([
        "rev-parse",
        "--verify",
        "-q",
        `${defaultRef(remote)}^{commit}`,
      ]);
      const staged: string[] = [];
      for (const [index, name] of names.entries()) {
        const folder = sourcePathOf(type, name);
        const files: [string, Buffer][] = [];
        for (const file of listed[index]!) {
          files.push([
            path.posix.relative(folder, file),
            // oxlint-disable-next-line no-await-in-loop -- one file at a time
            await readSubmittable(companionPath, folder, file),
          ]);
        }
        // oxlint-disable-next-line no-await-in-loop -- one folder at a time
        const theirs = await pendingContent(work, dir, folder);
        const unchanged = options.ifMissing?.includes(name) === true;
        const pending =
          theirs === null
            ? null
            : // oxlint-disable-next-line no-await-in-loop -- one folder at a time
              await readDeliveryRecord(within(dir, folder)).catch(() => null);
        const blocked = options.acknowledge?.includes(name) === true && Boolean(pending?.blocked);
        if (theirs !== null) {
          // A blocked change submitted again by name may accept its conflict, even unchanged.
          if (unchanged && !blocked) continue;
          const mine = submitted[folder]?.content;
          const here = contentOnly(files);
          // Never submitted or taken here: only the same content may be pushed over it.
          if (mine === undefined && theirs !== here) {
            throw new Error(
              `${name} is on ${pendingPlace(remote)} with other content than ${folder} here, which this checkout never submitted or took, and submitting would overwrite that. Move ${folder} aside, run \`mate artifact take ${name}\`, redo your edit there and submit it`,
            );
          }
          if (mine !== undefined && theirs !== mine) {
            // Only the local record differs: the pending branch's version stands.
            if (here === mine) continue;
            throw new Error(
              `${name} changed on ${pendingPlace(remote)} since this checkout submitted it (a teammate resolved or revised it), and submitting would overwrite that. Move ${folder} aside, run \`mate artifact take ${name}\`, redo your edit there and submit it`,
            );
          }
        }
        // oxlint-disable-next-line no-await-in-loop -- one folder at a time
        const prepared = await preparedRecord(
          local,
          sourceDir(companionPath, type, name),
          name,
          tip.stdout.trim(),
        );
        let record = withPendingSettlements(prepared, pending);
        const defaultTip = tip.stdout.trim();
        const base =
          blocked && isCommitId(defaultTip) && record.specBase !== defaultTip
            ? record.specBase
            : undefined;
        if (blocked && unchanged) {
          // The pending branch holds this very delta. Not accepted: it stays as it is, blocked.
          // oxlint-disable-next-line no-await-in-loop -- one folder at a time
          if (!base || !(await acceptsBlock(type, work, "HEAD", folder, base, defaultTip))) {
            continue;
          }
          record = { ...record, specBase: defaultTip };
        }
        records.set(name, record);
        // oxlint-disable-next-line no-await-in-loop -- one folder at a time
        await fs.rm(within(dir, folder), { recursive: true, force: true });
        const copied: [string, Buffer][] = [];
        for (const [relative, read] of files) {
          const target = within(dir, `${folder}/${relative}`);
          let content = read;
          // oxlint-disable-next-line no-await-in-loop -- one file at a time
          await fs.mkdir(path.dirname(target), { recursive: true });
          if (relative === DELIVERY_FILE) {
            // oxlint-disable-next-line no-await-in-loop -- same file
            await writeDeliveryRecord(path.dirname(target), record);
            // oxlint-disable-next-line no-await-in-loop -- same file
            content = await fs.readFile(target);
          } else {
            // oxlint-disable-next-line no-await-in-loop -- same file
            await fs.writeFile(target, content);
          }
          copied.push([relative, content]);
        }
        // A change that never had a record gets one, so its state travels with it.
        if (!copied.some(([relative]) => relative === DELIVERY_FILE)) {
          const target = within(dir, folder);
          // oxlint-disable-next-line no-await-in-loop -- one folder at a time
          await writeDeliveryRecord(target, record);
          // oxlint-disable-next-line no-await-in-loop -- same folder
          const written = await fs.readFile(path.join(target, DELIVERY_FILE));
          copied.push([DELIVERY_FILE, written]);
        }
        // Edited since the block: the delta as it is pushed decides.
        // oxlint-disable-next-line no-await-in-loop -- one folder at a time
        if (base && !unchanged && (await stagedAccepts(type, work, folder, base, defaultTip))) {
          record = { ...record, specBase: defaultTip };
          records.set(name, record);
          const target = within(dir, folder);
          // oxlint-disable-next-line no-await-in-loop -- same folder
          await writeDeliveryRecord(target, record);
          // oxlint-disable-next-line no-await-in-loop -- same folder
          const written = await fs.readFile(path.join(target, DELIVERY_FILE));
          copied.splice(
            copied.findIndex(([relative]) => relative === DELIVERY_FILE),
            1,
            [DELIVERY_FILE, written],
          );
        }
        digests.set(name, { digest: contentDigest(copied), content: contentOnly(copied) });
        staged.push(folder);
      }
      return staged;
    },
    deps,
  );
  if (pushed.status === "failed") return { ...pushed, group, changes: [...names] };
  for (const [name, record] of records) {
    // oxlint-disable-next-line no-await-in-loop -- one folder at a time
    await writeDeliveryRecord(sourceDir(companionPath, type, name), record);
  }
  const submittedAt = (deps.now?.() ?? new Date()).toISOString();
  const folders: Record<string, SubmittedFolder> = {};
  for (const [name, digest] of digests) {
    folders[sourcePathOf(type, name)] = { ...digest, submittedAt };
  }
  updateSubmittedFolders(companionPath, folders, [], deps.stateHome);
  return { ...pushed, group, changes: [...records.keys()] };
}

/**
 * True when `relative` holds untracked or changed files in the checkout `git` runs in; null when
 * Git cannot tell.
 */
async function hasLocalWork(git: CompanionGit, relative: string): Promise<boolean | null> {
  const status = await git.run([
    ...LITERAL_PATHSPECS,
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
    "--",
    relative,
  ]);
  return status.status === 0 ? status.stdout.length > 0 : null;
}

/**
 * True when the local folder `relative` should be pushed again with its group: it differs from
 * what this checkout last submitted of it, committed since or not, or was never submitted here
 * and holds local work. One unchanged since its own submit stays as the pending branch has it,
 * where a teammate may have resolved it since. Null when Git cannot tell: neither pushing nor
 * skipping it is safe.
 */
async function editedSinceSubmit(
  git: CompanionGit,
  companionPath: string,
  relative: string,
  submitted: Record<string, SubmittedFolder>,
): Promise<boolean | null> {
  const recorded = submitted[relative];
  if (!recorded) return hasLocalWork(git, relative);
  const files = await ownFiles(git, companionPath, relative);
  if (!files) return null;
  const dir = path.join(companionPath, ...relative.split("/"));
  return (await folderDigest(dir, files)) !== recorded.digest;
}

/**
 * True when local change `name` holds work the pending branch lacks: it is not `submitted` here
 * (a teammate's submitted change may share its name), or was edited since this checkout
 * submitted or took it.
 */
export async function hasUnsubmittedWork(
  companionPath: string,
  name: string,
  deps: Pick<SubmitDeps, "git" | "artifactType" | "stateHome"> = {},
): Promise<boolean> {
  const type = deps.artifactType ?? defaultArtifactType();
  if ((await submissionState(sourceDir(companionPath, type, name))) !== "submitted") return true;
  const relative = sourcePathOf(type, name);
  const submitted = readSubmittedFolders(companionPath, deps.stateHome);
  if (!submitted[relative]) return false;
  const git = (deps.git ?? defaultGit)(companionPath);
  return (await editedSinceSubmit(git, companionPath, relative, submitted)) === true;
}

/**
 * The `submitted` members of `groups`, those in `named` left out, that {@link submitGroups} pushes
 * as edited. Call it before refreshing them: a refresh rewrites `delivery.yaml`, which the
 * comparison covers. A member Git cannot judge is left out, since {@link submitGroups} fails its
 * group.
 */
export async function editedSubmittedMembers(
  companionPath: string,
  groups: ReadonlySet<string>,
  named: readonly string[],
  deps: Pick<SubmitDeps, "git" | "artifactType" | "stateHome"> = {},
): Promise<LocalMember[]> {
  const type = deps.artifactType ?? defaultArtifactType();
  const git = (deps.git ?? defaultGit)(companionPath);
  const submitted = readSubmittedFolders(companionPath, deps.stateHome);
  const edited: LocalMember[] = [];
  for (const member of await localMembers(companionPath, type)) {
    if (member.state !== "submitted" || !groups.has(member.group)) continue;
    if (named.includes(member.name)) continue;
    const relative = sourcePathOf(type, member.name);
    // oxlint-disable-next-line no-await-in-loop -- a few members per group
    if ((await editedSinceSubmit(git, companionPath, relative, submitted)) === true) {
      edited.push(member);
    }
  }
  return edited;
}

export type GroupStatus = "pushed" | "unchanged" | "waiting" | "failed";

export interface GroupSubmission {
  group: string;
  status: GroupStatus;
  /** Local members of the group still `active` and not submitted with it, which it waits for. */
  waitingFor: string[];
  /** Set unless the group waits. */
  push?: GroupPush;
}

/**
 * Submits the Delivery Groups of `names`, each whole and in one commit that sets its changes
 * `submitted`. A group waits, pushing and changing nothing, while a local member that is not
 * named is still `active`: a Workset lands together or not at all. A dropped member comes back
 * only when named. Members already submitted, named or not, are pushed again only when edited
 * since this checkout submitted or took them, so a teammate's later edit on the pending branch
 * is never overwritten by a stale local copy; a named one the pending branch no longer holds is
 * pushed again as it is.
 */
export async function submitGroups(
  companionPath: string,
  names: readonly string[],
  options: SubmitDeps = {},
): Promise<GroupSubmission[]> {
  const type = options.artifactType ?? defaultArtifactType();
  const members = await localMembers(companionPath, type);
  const local = (options.git ?? defaultGit)(companionPath);
  const groups = [
    ...new Set(
      names.flatMap((name) => members.find((member) => member.name === name)?.group ?? []),
    ),
  ];
  const submissions: GroupSubmission[] = [];
  for (const group of groups) {
    const inGroup = members.filter((member) => member.group === group);
    const waitingFor = inGroup
      .filter((member) => member.state === "active" && !names.includes(member.name))
      .map((member) => member.name);
    if (waitingFor.length > 0) {
      submissions.push({ group, status: "waiting", waitingFor });
      continue;
    }
    const pushed: string[] = [];
    const ifMissing: string[] = [];
    const unknown: string[] = [];
    const submitted = readSubmittedFolders(companionPath, options.stateHome);
    for (const member of inGroup) {
      const named = names.includes(member.name);
      if (member.state === "dropped" && !named) continue;
      const edited =
        (named && member.state !== "submitted") ||
        // oxlint-disable-next-line no-await-in-loop -- a few members per group
        (await editedSinceSubmit(local, companionPath, sourcePathOf(type, member.name), submitted));
      if (edited === null) unknown.push(member.name);
      else if (edited || named) pushed.push(member.name);
      if (edited === false && named) ifMissing.push(member.name);
    }
    if (unknown.length > 0) {
      const detail = `Git could not tell whether ${unknown.join(", ")} changed locally; nothing was pushed.`;
      const push: GroupPush = { ...failed("failed", detail, null), group, changes: [] };
      submissions.push({ group, status: "failed", waitingFor, push });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one push per group, in order
    const push = await pushGroup(companionPath, group, pushed, options, {
      ifMissing,
      acknowledge: names,
    });
    submissions.push({ group, status: push.status, waitingFor, push });
  }
  return submissions;
}

export interface DropResult {
  change: string;
  status: "dropped" | "refused";
  /** The change's Delivery Group, once known. */
  group: string | null;
  /** Whether this run removed the folder from the pending branch. */
  pushed: boolean;
  commit: string | null;
  reason?: PendingFailure | "missing";
  message: string;
}

/**
 * Drops change `name`: sets `state: dropped` in its local folder, when this checkout has one,
 * and removes its folder from the pending branch by a commit pushed without force, from any
 * machine. The folder stays in the pending branch's history.
 */
export async function dropSubmitted(
  companionPath: string,
  name: string,
  deps: SubmitDeps = {},
): Promise<DropResult> {
  const type = deps.artifactType ?? defaultArtifactType();
  const refused = (message: string, reason: DropResult["reason"]): DropResult => ({
    change: name,
    status: "refused",
    group: null,
    pushed: false,
    commit: null,
    reason,
    message,
  });
  if (!isChangeName(name)) return refused(`mate: "${name}" is no change name.`, "missing");
  const localDir = sourceDir(companionPath, type, name);
  const local = await pathIsDirectory(localDir);
  let group = local ? (await groupOfChange(companionPath, name, type)).group : null;

  let found = false;
  const removed = await commitStaged(
    companionPath,
    `chore(${type.name}): drop ${name}`,
    async (dir) => {
      const target = within(dir, sourcePathOf(type, name));
      found = await pathIsDirectory(target);
      if (!found) return [];
      if (!group) {
        const record = await readDeliveryRecord(target).catch(() => null);
        group = deliveryGroupFor(name, record, await scopedRepositories(target)).group;
      }
      await fs.rm(target, { recursive: true, force: true });
      return [sourcePathOf(type, name)];
    },
    deps,
  );
  // Without an upstream there is no pending branch to remove it from: dropped here alone.
  if (removed.status === "failed" && removed.reason === "no-remote" && local) {
    await writeSubmissionState(localDir, name, "dropped");
    updateSubmittedFolders(companionPath, {}, [sourcePathOf(type, name)], deps.stateHome);
    return {
      change: name,
      status: "dropped",
      group,
      pushed: false,
      commit: null,
      message: `Dropped ${name} locally; the companion has no upstream.`,
    };
  }
  if (removed.status === "failed") {
    return {
      ...refused(
        `mate: removing ${name} from the pending branch failed: ${removed.detail ?? removed.reason}.`,
        removed.reason,
      ),
      group,
    };
  }
  if (!found && !local) return refused(`mate: ${name} is neither local nor submitted.`, "missing");
  // Only after the pending branch let go of it, so a failed removal leaves the state as it was.
  if (local) await writeSubmissionState(localDir, name, "dropped");
  updateSubmittedFolders(companionPath, {}, [sourcePathOf(type, name)], deps.stateHome);
  const place = removed.pendingBranch ?? "the pending branch";
  return {
    change: name,
    status: "dropped",
    group,
    pushed: removed.status === "pushed",
    commit: removed.commit,
    message: found
      ? `Dropped ${name}: removed it from ${place}${local ? " and set its local state to dropped" : ""}.`
      : `Dropped ${name} locally; ${place} does not hold it.`,
  };
}

export interface TakeResult {
  change: string;
  status: "taken" | "refused";
  /** The folder in the checkout, relative to the companion. */
  path: string | null;
  reason?: "no-remote" | "fetch-failed" | "missing" | "exists" | "failed";
  message: string;
}

/**
 * Takes submitted change `name` into the checkout: writes its folder as the fetched pending
 * branch has it, untracked, and records it as submitted from this checkout, so an edit is
 * submitted again like one of the checkout's own and the folder gives way once its archive
 * arrives. Refused while the checkout holds a folder of that name; nothing is pushed.
 */
export async function takeSubmitted(
  companionPath: string,
  name: string,
  deps: SubmitDeps = {},
): Promise<TakeResult> {
  const type = deps.artifactType ?? defaultArtifactType();
  const refused = (reason: TakeResult["reason"], message: string): TakeResult => ({
    change: name,
    status: "refused",
    path: null,
    reason,
    message,
  });
  if (!isChangeName(name)) return refused("missing", `mate: "${name}" is no change name.`);
  const relative = sourcePathOf(type, name);
  const dir = sourceDir(companionPath, type, name);
  if (await pathIsDirectory(dir)) {
    return refused("exists", `mate: ${relative} is in this checkout already; nothing was taken.`);
  }
  const git = (deps.git ?? defaultGit)(companionPath);
  const remote = await stagingRemote(git);
  if (!remote) return refused("no-remote", "mate: the companion has no upstream.");
  const fetched = await fetchPendingBranches(git, remote);
  if ("error" in fetched) return refused("fetch-failed", `mate: ${fetched.error}`);
  // One commit for every read: a ref could move between the check and the write.
  const tip = (
    await git.run(["rev-parse", "--verify", "-q", `${pendingRef(remote)}^{commit}`])
  ).stdout.trim();
  const record = isCommitId(tip)
    ? await git.run(["show", "--end-of-options", `${tip}:${relative}/${DELIVERY_FILE}`])
    : null;
  if (record?.status !== 0 || !/^state:\s*submitted\s*$/m.test(record.stdout)) {
    return refused("missing", `mate: ${name} is not submitted on ${pendingPlace(remote)}.`);
  }
  // Anyone may push the inbox: a link there must not reach the checkout, where it is followed.
  const linked = await linkedContentPaths(git, tip, [relative]);
  if (linked === null || linked.length > 0) {
    return refused(
      "failed",
      linked === null
        ? `mate: reading ${relative} on ${pendingPlace(remote)} failed; nothing was taken.`
        : `mate: ${pendingPlace(remote)} holds a symbolic link or submodule at ${linked.join(", ")}; Mate does not take it.`,
    );
  }
  // The work tree only: the index stays as it is, so the folder is untracked like a submitted one.
  const written = await git.run([
    ...LITERAL_PATHSPECS,
    "restore",
    `--source=${tip}`,
    "--worktree",
    "--",
    `${relative}/`,
  ]);
  const files = written.status === 0 ? await ownFiles(git, companionPath, relative) : null;
  if (!files || files.length === 0) {
    await fs.rm(dir, { recursive: true, force: true });
    return refused(
      "failed",
      `mate: writing ${relative} failed; nothing was taken. ${describeGitFailure(written)}`,
    );
  }
  updateSubmittedFolders(
    companionPath,
    {
      [relative]: {
        digest: await folderDigest(dir, files),
        content: await folderDigest(
          dir,
          files.filter((file) => file !== DELIVERY_FILE),
        ),
        submittedAt: (deps.now?.() ?? new Date()).toISOString(),
      },
    },
    [],
    deps.stateHome,
  );
  return {
    change: name,
    status: "taken",
    path: relative,
    message: `Took ${name} into ${relative} as ${pendingPlace(remote)} has it. Edit it, then submit it again with \`mate artifact submit ${name}\`.`,
  };
}
