/**
 * Submitted change folders whose published archive arrives from upstream. Submit pushes a change
 * folder to the inbox from a temporary worktree, so the checkout keeps what it submitted
 * uncommitted (the whole folder, or its edits when the folder was committed while active) until
 * synchronization brings its archive. This decides which local folders give way to it.
 *
 * Lives under `runtime/` because the session-start sync needs it and may not import `lib/`.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import { trailerRecordsAt } from "./artifact-trailers";
import { LITERAL_PATHSPECS, nulPaths, type CompanionGit } from "./companion-git";
import { readSubmittedFolders, updateSubmittedFolders } from "./companion-git-state";
import { errorMessage } from "./error-message";

/** Where a type keeps change folders and their archives; the OpenSpec layout by default. */
export interface SubmittedLayout {
  /** Directory holding one folder per change, relative to the companion. */
  source: string;
  /**
   * Directory holding one folder per archived record, relative to the companion; absent for a
   * type that keeps no archive, whose records are read from {@link trailer}.
   */
  archiveRoot?: string;
  /** The type's name in `Mate-Artifact: <type>/<id>` trailers, read when it keeps no archive. */
  trailer?: string;
  /** The change name archived record `id` was made from, or null for no record. */
  recordName: (id: string) => string | null;
}

/** OpenSpec's layout, as the built-in artifact type declares it. */
export const OPENSPEC_LAYOUT: SubmittedLayout = {
  source: "openspec/changes",
  archiveRoot: "openspec/changes/archive",
  recordName: (id) => /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(id)?.[1] ?? null,
};

async function walk(current: string, relative: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return walk(path.join(current, entry.name), entryRelative);
      return entry.isFile() ? [entryRelative] : [];
    }),
  );
  return nested.flat();
}

/** Every file below `dir`, as sorted POSIX paths relative to it; symlinks and others skipped. */
async function filesBelow(dir: string): Promise<string[]> {
  return (await walk(dir, "")).toSorted();
}

/**
 * The regular files of companion folder `relative` its Git would add, tracked or untracked but
 * not ignored, as sorted POSIX paths relative to the folder: what submit copies. Null when Git
 * cannot list them.
 */
export async function ownFiles(
  git: CompanionGit,
  companionPath: string,
  relative: string,
): Promise<string[] | null> {
  const listed = await lines(git, [
    ...LITERAL_PATHSPECS,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    `${relative}/`,
  ]);
  if (listed === null) return null;
  const files: string[] = [];
  for (const file of new Set(listed)) {
    if (file.endsWith("/")) continue;
    // oxlint-disable-next-line no-await-in-loop -- a handful of files per change
    const stat = await fs.lstat(path.join(companionPath, ...file.split("/"))).catch(() => null);
    if (stat?.isFile()) files.push(path.posix.relative(relative, file));
  }
  return files.toSorted();
}

/** SHA-256 over relative file paths and contents, in path order; what submit records. */
export function contentDigest(files: Iterable<readonly [string, Uint8Array]>): string {
  const hash = createHash("sha256");
  const sorted = [...files].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [file, content] of sorted) {
    hash.update(file).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

/**
 * {@link contentDigest} over `files` of `dir`, paths relative to it; every regular file below
 * `dir` when `files` is omitted.
 */
export async function folderDigest(dir: string, files?: readonly string[]): Promise<string> {
  const listed = files ?? (await filesBelow(dir));
  const contents = await Promise.all(
    listed.map(
      async (file) => [file, await fs.readFile(path.join(dir, ...file.split("/")))] as const,
    ),
  );
  return contentDigest(contents);
}

export interface SubmittedArrivals {
  /** Uncommitted folders unchanged since submit whose published archive arrives. */
  discard: string[];
  /** Per folder of {@link discard}, the files submit copied; ignored files stay. */
  discardFiles: Record<string, string[]>;
  /**
   * Per folder of {@link discard} that `HEAD` holds files of, those files: they go back to
   * their committed version instead of being removed.
   */
  committed: Record<string, string[]>;
  /** Folders edited since submit whose published archive arrives; kept. */
  edited: string[];
  /** Submitted records to forget: their archive arrived. */
  forget: string[];
}

async function lines(git: CompanionGit, args: readonly string[]): Promise<string[] | null> {
  const result = await git.run(args);
  return result.status === 0 ? nulPaths(result.stdout) : null;
}

/** Blob ids by path relative to `prefix`, from the NUL-split entries of `git ls-tree -r -z`. */
export function treeBlobs(entries: readonly string[], prefix: string): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    blobs.set(
      path.posix.relative(prefix, entry.slice(tab + 1)),
      entry.slice(0, tab).split(" ")[2]!,
    );
  }
  return blobs;
}

/** Blob ids by path relative to `prefix` at `ref`. */
export async function blobsAt(
  git: CompanionGit,
  ref: string,
  prefix: string,
): Promise<Map<string, string>> {
  const listed = await lines(git, [
    "ls-tree",
    "-r",
    "-z",
    "--end-of-options",
    ref,
    "--",
    `${prefix}/`,
  ]);
  return treeBlobs(listed ?? [], prefix);
}

/** True when `local`, the files of folder `relative`, are exactly the files `incoming` names. */
async function holdsExactly(
  git: CompanionGit,
  relative: string,
  local: readonly string[],
  incoming: Map<string, string>,
): Promise<boolean> {
  if (local.length !== incoming.size || local.some((file) => !incoming.has(file))) return false;
  const hashed = await git.run([
    "hash-object",
    "--",
    ...local.map((file) => `${relative}/${file}`),
  ]);
  if (hashed.status !== 0) return false;
  const ids = hashed.stdout.trim().split("\n");
  return local.every((file, index) => ids[index] === incoming.get(file));
}

/**
 * Archived record ids at `ref`, by change name: the folders below `layout.archiveRoot`, or for a
 * type without an archive the records its history published.
 */
async function archivedRecords(
  git: CompanionGit,
  ref: string,
  layout: SubmittedLayout,
): Promise<Map<string, Set<string>>> {
  const listed =
    layout.archiveRoot === undefined
      ? layout.trailer === undefined
        ? []
        : (await trailerRecordsAt(git, ref, layout.trailer)).map((record) => record.id)
      : await lines(git, [
          "ls-tree",
          "-z",
          "--name-only",
          "--end-of-options",
          ref,
          "--",
          `${layout.archiveRoot}/`,
        ]);
  const records = new Map<string, Set<string>>();
  for (const entry of listed ?? []) {
    const id = entry.split("/").at(-1)!;
    const name = layout.recordName(id);
    if (name) records.set(name, (records.get(name) ?? new Set()).add(id));
  }
  return records;
}

const DELIVERY_FILE = "delivery.yaml";

/** The `specBase` a Delivery Record's YAML names, or null. */
function specBaseOf(yaml: string | null): string | null {
  if (!yaml) return null;
  try {
    const specBase = (parse(yaml) as { specBase?: unknown } | null)?.specBase;
    return typeof specBase === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(specBase)
      ? specBase
      : null;
  } catch {
    return null;
  }
}

/**
 * The repositories and branches a Delivery Record's YAML names, sorted; null when it names no
 * branch or does not parse.
 */
function deliveryBranchesOf(yaml: string | null): string | null {
  if (!yaml) return null;
  try {
    const deliveries = (parse(yaml) as { deliveries?: unknown } | null)?.deliveries;
    const branches = (Array.isArray(deliveries) ? deliveries : []).flatMap((entry) => {
      const { repository, branch } = (entry ?? {}) as { repository?: unknown; branch?: unknown };
      return typeof repository === "string" && typeof branch === "string" && branch
        ? [`${repository.toLowerCase()}\0${branch}`]
        : [];
    });
    return branches.length > 0 ? branches.toSorted().join("\n") : null;
  } catch {
    return null;
  }
}

/** Archives are dated in the publisher's local time: UTC−12 is the earliest date anywhere. */
const EARLIEST_UTC_OFFSET_MS = 12 * 60 * 60 * 1000;

/** The earliest local date any timezone shows at ISO time `iso`; its own date when unparsable. */
function earliestLocalDay(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time)
    ? iso.slice(0, 10)
    : new Date(time - EARLIEST_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * True when `incoming` brings an archive of the submitted folder `relative` that `current`
 * lacks: not dated before the submit, and with the folder's `specBase` when both record one
 * (or, when they differ, the folder's repositories and branches, as after a resolution), else with the folder's files besides its Delivery Record, so an archive of another change of
 * the same name does not count. `local` lists the folder's own files; an empty folder has
 * nothing to lose, and only its record is forgotten.
 */
async function newArchive(
  git: CompanionGit,
  dir: string,
  relative: string,
  local: readonly string[],
  submittedAt: string,
  incomingRef: string,
  layout: SubmittedLayout,
  incoming: Map<string, Set<string>>,
  current: Map<string, Set<string>>,
): Promise<boolean> {
  const name = path.posix.basename(relative);
  const known = current.get(name) ?? new Set<string>();
  const day = earliestLocalDay(submittedAt);
  const candidates = [...(incoming.get(name) ?? [])].filter((id) => {
    const dated = /^\d{4}-\d{2}-\d{2}/.exec(id)?.[0];
    return !known.has(id) && (!dated || dated >= day);
  });
  if (candidates.length === 0) return false;
  // Without an archive there is nothing to compare the folder with: the record alone decides.
  if (local.length === 0 || layout.archiveRoot === undefined) return true;
  const record = await fs.readFile(path.join(dir, DELIVERY_FILE), "utf8").catch(() => null);
  const base = specBaseOf(record);
  const branches = deliveryBranchesOf(record);
  const content = local.filter((file) => file !== DELIVERY_FILE);
  for (const id of candidates) {
    const archive = `${layout.archiveRoot}/${id}`;
    if (base) {
      // oxlint-disable-next-line no-await-in-loop -- rarely more than one candidate
      const shown = await git.run(["show", `${incomingRef}:${archive}/${DELIVERY_FILE}`]);
      const archived = shown.status === 0 ? specBaseOf(shown.stdout) : null;
      if (archived) {
        // A resolution rewrites `specBase`; the same branches still name this change.
        if (archived === base || (branches && deliveryBranchesOf(shown.stdout) === branches)) {
          return true;
        }
        continue;
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- same candidate
    const blobs = await blobsAt(git, incomingRef, archive);
    blobs.delete(DELIVERY_FILE);
    // oxlint-disable-next-line no-await-in-loop -- same candidate
    if (await holdsExactly(git, relative, content, blobs)) return true;
  }
  return false;
}

/**
 * Decides, before a merge of `incomingRef`, which change folders this checkout submitted give
 * way: one with uncommitted files whose published archive arrives while the folder still matches
 * its submitted digest. An edited folder is kept, and so is every folder not published yet.
 * Local Git reads only; changes nothing.
 */
export async function planSubmittedArrivals(
  git: CompanionGit,
  companionPath: string,
  incomingRef: string,
  layout: SubmittedLayout = OPENSPEC_LAYOUT,
  homeDir?: string,
): Promise<SubmittedArrivals> {
  const plan: SubmittedArrivals = {
    discard: [],
    discardFiles: {},
    committed: {},
    edited: [],
    forget: [],
  };
  const recorded = Object.entries(readSubmittedFolders(companionPath, homeDir)).filter(
    ([relative]) => path.posix.dirname(relative) === layout.source,
  );
  if (recorded.length === 0) return plan;
  const [incoming, current] = await Promise.all([
    archivedRecords(git, incomingRef, layout),
    archivedRecords(git, "HEAD", layout),
  ]);
  for (const [relative, { digest, submittedAt }] of recorded) {
    const dir = path.join(companionPath, ...relative.split("/"));
    // oxlint-disable-next-line no-await-in-loop -- a few submitted folders per checkout
    const local = await ownFiles(git, companionPath, relative);
    if (local === null) continue;
    // oxlint-disable-next-line no-await-in-loop -- same folder
    const archived = await newArchive(
      git,
      dir,
      relative,
      local,
      submittedAt,
      incomingRef,
      layout,
      incoming,
      current,
    );
    if (!archived) continue;
    plan.forget.push(relative);
    if (local.length === 0) continue;
    // oxlint-disable-next-line no-await-in-loop -- same folder
    const changed = await lines(git, [
      ...LITERAL_PATHSPECS,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      `${relative}/`,
    ]);
    // A folder committed as it is needs no help: Git merges it.
    if (changed === null || changed.length === 0) continue;
    // oxlint-disable-next-line no-await-in-loop -- same folder
    if ((await folderDigest(dir, local)) !== digest) {
      plan.edited.push(relative);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- same folder
    const committed = await blobsAt(git, "HEAD", relative);
    plan.discard.push(relative);
    plan.discardFiles[relative] = local;
    if (committed.size > 0) plan.committed[relative] = [...committed.keys()];
  }
  return plan;
}

export interface DiscardedArrivals {
  /** The folders that gave way. */
  discarded: string[];
  /** After the merge: drops the copies and forgets the records `plan` forgets. */
  commit: () => Promise<void>;
  /** After a merge that did not move `HEAD`: lays the folders back as they were. */
  restore: () => Promise<void>;
}

/** The POSIX path `file` below `root`. */
function at(root: string, file: string): string {
  return path.join(root, ...file.split("/"));
}

/** Removes `dir` and its parents below `stop` while they are empty. */
async function pruneEmpty(dir: string, stop: string): Promise<void> {
  for (let current = dir; current.startsWith(`${stop}${path.sep}`);) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- walks up one level at a time
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

/**
 * Copies folder `relative` to `scratch`, then leaves it as `HEAD` has it: the files submit
 * copied that `HEAD` lacks are removed, the others go back to their committed version.
 */
async function giveWay(
  git: CompanionGit,
  companionPath: string,
  scratch: string,
  relative: string,
  files: readonly string[],
  committed: readonly string[],
): Promise<void> {
  await fs.cp(at(companionPath, relative), at(scratch, relative), { recursive: true });
  for (const name of files) {
    if (committed.includes(name)) continue;
    const file = at(companionPath, `${relative}/${name}`);
    // oxlint-disable-next-line no-await-in-loop -- a handful of files
    await fs.rm(file);
    // oxlint-disable-next-line no-await-in-loop -- same file
    await pruneEmpty(path.dirname(file), companionPath);
  }
  if (committed.length === 0) return;
  for (const command of ["reset", "checkout"]) {
    // oxlint-disable-next-line no-await-in-loop -- in order
    const result = await git.run([
      ...LITERAL_PATHSPECS,
      command,
      "-q",
      "HEAD",
      "--",
      `${relative}/`,
    ]);
    if (result.status !== 0) throw new Error(`git ${command} failed: ${result.stderr.trim()}`);
  }
}

/** Lays the copy of folder `relative` in `scratch` back over it. */
async function comeBack(companionPath: string, scratch: string, relative: string): Promise<void> {
  await fs.cp(at(scratch, relative), at(companionPath, relative), { recursive: true });
}

const headOf = async (git: CompanionGit): Promise<string> =>
  (await git.run(["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();

/**
 * Makes the folders `plan` discards give way, so the merge can bring their archives: each is copied to a scratch directory and left as `HEAD` has it; files the
 * companion ignores stay. Best effort: a folder that cannot give way is laid back and left for
 * the merge to report; when laying it back fails too, the folders that gave way before it are
 * laid back and the failure thrown. Records are forgotten only on {@link DiscardedArrivals.commit}.
 */
export async function discardSubmittedArrivals(
  git: CompanionGit,
  companionPath: string,
  plan: SubmittedArrivals,
  homeDir?: string,
): Promise<DiscardedArrivals> {
  const forget = async () => {
    if (plan.forget.length > 0) updateSubmittedFolders(companionPath, {}, plan.forget, homeDir);
  };
  if (plan.discard.length === 0) return { discarded: [], commit: forget, restore: async () => {} };
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "mate-discarded-"));
  const before = await headOf(git);
  const discarded: string[] = [];
  const keptIn = (error: unknown) =>
    new Error(`${errorMessage(error)}; the submitted files are kept in ${scratch}`, {
      cause: error,
    });
  for (const relative of plan.discard) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one folder at a time
      await giveWay(
        git,
        companionPath,
        scratch,
        relative,
        plan.discardFiles[relative] ?? [],
        plan.committed[relative] ?? [],
      );
      discarded.push(relative);
    } catch {
      // Left as it was; the merge reports the collision.
      try {
        // oxlint-disable-next-line no-await-in-loop -- same folder
        await comeBack(companionPath, scratch, relative);
      } catch (error) {
        // No handle is returned, so the folders that already gave way come back here.
        for (const earlier of discarded) {
          // oxlint-disable-next-line no-await-in-loop -- one folder at a time
          await comeBack(companionPath, scratch, earlier).catch(() => {});
        }
        throw keptIn(error);
      }
    }
  }
  return {
    discarded,
    commit: async () => {
      await fs.rm(scratch, { recursive: true, force: true });
      await forget();
    },
    restore: async () => {
      // Once `HEAD` moved, what the merge brought stands, and so do the archives it brought.
      if ((await headOf(git)) === before) {
        try {
          for (const relative of discarded) {
            // oxlint-disable-next-line no-await-in-loop -- one folder at a time
            await comeBack(companionPath, scratch, relative);
          }
        } catch (error) {
          throw keptIn(error);
        }
      } else {
        await forget();
      }
      await fs.rm(scratch, { recursive: true, force: true });
    },
  };
}

/** The operator warning for a folder edited after submit whose published archive arrived. */
export function editedAfterSubmitWarning(relative: string): string {
  return `${relative} was edited after it was submitted; kept. Submit ${path.posix.basename(relative)} again to share the edit.`;
}
