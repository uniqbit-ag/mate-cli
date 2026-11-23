import { spawn } from "node:child_process";
import path from "node:path";

import { parse } from "yaml";

import { nulPaths, parseBlobBatch, parseRemoteRef } from "./companion-git";
import { readSubmittedFolders } from "./companion-git-state";
import { OPENSPEC_LAYOUT, treeBlobs, type SubmittedLayout } from "./submitted-arrivals";

/** A change's Delivery Record file. */
export const DELIVERY_FILE = "delivery.yaml";

/**
 * The companion's inbox, the pending branch: an orphan branch holding only submitted change
 * folders, so the default branch holds published content only and may be protected.
 */
export const INBOX_BRANCH = "mate/inbox";

/** Bound on each local Git command; a launch must not wait on a stuck repository. */
const GIT_TIMEOUT_MS = 2_000;

/** Output kept of one Git command; a larger one counts as failed. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

interface GitRead {
  timeoutMs?: number;
  input?: string;
  /** Options before `-C`, such as `--literal-pathspecs`. */
  globals?: readonly string[];
}

/**
 * Stdout of a bounded local Git command; null when it fails, times out or prints too much.
 * Asynchronous, so a slow repository never blocks the caller's thread.
 */
function gitBytes(
  companionPath: string,
  args: readonly string[],
  options: GitRead = {},
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn("git", [...(options.globals ?? []), "-C", companionPath, ...args], {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) child.kill();
      else chunks.push(chunk);
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks) : null));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

async function gitText(
  companionPath: string,
  args: readonly string[],
  options: GitRead = {},
): Promise<string | null> {
  return (await gitBytes(companionPath, args, options))?.toString("utf8") ?? null;
}

/**
 * A repository as the companion's `repos/` folders name it: `acme/widgets` is `acme_widgets`.
 * A repository named `change` is `_change`, so it cannot collide with `change/<name>`; one
 * named `.` or `..` is prefixed the same way, so it never names a parent folder.
 */
export function repositorySegment(repository: string): string {
  const segment = repository.toLowerCase().replaceAll("/", "_");
  return segment === "change" || /^\.+$/.test(segment) ? `_${segment}` : segment;
}

/** True when `name` passes `git check-ref-format --branch`, checked without Git. */
export function isBranchName(name: string): boolean {
  if (!name || name === "@" || name.startsWith("-") || name.endsWith("/") || name.endsWith(".")) {
    return false;
  }
  // oxlint-disable-next-line no-control-regex -- control characters are invalid in refs
  if (/[\u0000- \u007f~^:?*[\\]|\.\.|@\{|\/\//.test(name)) return false;
  return name
    .split("/")
    .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/**
 * Characters a group name may hold: the name reaches shell commands agents run, so it stays
 * free of quotes, `$`, backquotes and other shell syntax, and starts with a letter, digit or `_`,
 * so it is never read as an option.
 */
export const GROUP_CHARACTERS = /^\w[\w./-]*$/;

/**
 * True for a change name the inbox takes: {@link GROUP_CHARACTERS} without `/`, so
 * `change/<name>` is a group name and the name itself is safe in a shell command. Narrower than
 * a local change name; a folder on the inbox named otherwise is not read.
 */
export function isSubmittedName(name: string): boolean {
  return /^\w[\w.-]*$/.test(name);
}

/** Longest inbox text printed on one line. */
const INBOX_TEXT_LIMIT = 200;

/**
 * Text from the inbox, which any teammate can push, as one printable line: control, bidi and
 * line-separator characters become spaces, so it can neither drive the terminal nor pass for a
 * line of its own.
 */
export function inboxText(value: string): string {
  const plain = value
    // oxlint-disable-next-line no-control-regex -- control characters are what is removed
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  return plain.length > INBOX_TEXT_LIMIT ? `${plain.slice(0, INBOX_TEXT_LIMIT)}…` : plain;
}

/** A recorded delivery whose repository and branch can name a Delivery Group. */
export function namesGroup(entry: { repository?: unknown; branch?: unknown }): boolean {
  return (
    typeof entry.branch === "string" &&
    typeof entry.repository === "string" &&
    isBranchName(entry.branch) &&
    GROUP_CHARACTERS.test(entry.branch) &&
    GROUP_CHARACTERS.test(entry.repository)
  );
}

/** The Delivery Group a delivery names: `<repository>/<branch>`. */
export function groupOf(entry: { repository: string; branch: string }): string {
  return `${repositorySegment(entry.repository)}/${entry.branch}`;
}

/** True when `a` and `b` are the same text apart from CRLF line endings. */
export function sameTextBesidesLineEndings(a: string, b: string): boolean {
  return a.replaceAll("\r\n", "\n") === b.replaceAll("\r\n", "\n");
}

/**
 * The archived record among `ids` holding exactly the files of `source` (blob ids by path, the
 * Delivery Record aside: publication settles it), newest first; null for none. An archive of
 * the same name with other files is another change's, so a reused name stays pending. Blobs
 * that differ are still the same file when `sameBlob` says so: the default branch's Git
 * attributes may normalise line endings the inbox, which has none, stores as written.
 */
export async function matchingArchive(
  ids: readonly string[],
  source: ReadonlyMap<string, string> | null,
  archivedAt: (id: string) => Promise<ReadonlyMap<string, string> | null>,
  sameBlob?: (sourceBlob: string, archivedBlob: string) => Promise<boolean>,
): Promise<string | null> {
  if (ids.length === 0 || !source || source.size === 0) return null;
  for (const id of ids.toReversed()) {
    // oxlint-disable-next-line no-await-in-loop -- rarely more than one archive per name
    const archived = await archivedAt(id);
    if (archived?.size !== source.size) continue;
    let same = true;
    for (const [file, blob] of source) {
      const other = archived.get(file);
      if (other === blob) continue;
      // oxlint-disable-next-line no-await-in-loop -- only blobs that differ are read
      if (other === undefined || !sameBlob || !(await sameBlob(blob, other))) {
        same = false;
        break;
      }
    }
    if (same) return id;
  }
  return null;
}

export interface TrackingRefs {
  defaultRef: string;
  pendingRef: string;
}

/**
 * The remote-tracking refs of the default branch (`<remote>/HEAD`, else the upstream branch) and
 * of the pending branch; null without an upstream, which is the branch's `@{u}`, then
 * `origin/HEAD`, then `origin/main` or `origin/master`, as `upstreamTarget` resolves it. Off the
 * caller's thread: the session banner reads it.
 */
export async function trackingRefs(companionPath: string): Promise<TrackingRefs | null> {
  const [tracked, originHead] = await Promise.all([
    gitText(companionPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    gitText(companionPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
  ]);
  let upstream = parseRemoteRef(tracked ?? "") ?? parseRemoteRef(originHead ?? "");
  for (const branch of upstream ? [] : ["main", "master"]) {
    const ref = `refs/remotes/origin/${branch}`;
    // oxlint-disable-next-line no-await-in-loop -- a decision chain, off the common path
    if ((await gitText(companionPath, ["show-ref", "--verify", "--quiet", ref])) !== null) {
      upstream = { remote: "origin", branch, ref: `origin/${branch}` };
      break;
    }
  }
  if (!upstream || upstream.remote.startsWith("-") || upstream.branch.startsWith("-")) return null;
  const { remote } = upstream;
  // `origin/HEAD` was read above; another remote's is asked for.
  const head = (
    remote === "origin"
      ? originHead
      : await gitText(companionPath, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "--end-of-options",
          `refs/remotes/${remote}/HEAD`,
        ])
  )?.trim();
  const defaultBranch = head?.startsWith(`${remote}/`)
    ? head.slice(remote.length + 1)
    : upstream.branch;
  const defaultRef = `refs/remotes/${remote}/${defaultBranch}`;
  return { defaultRef, pendingRef: `refs/remotes/${remote}/${INBOX_BRANCH}` };
}

/**
 * Fetch refspec for the inbox, as a pattern: it matches nothing on a remote without an inbox
 * instead of failing the fetch it rides along with.
 */
export function inboxRefspec(remote: string): string {
  return `+refs/heads/${INBOX_BRANCH}*:refs/remotes/${remote}/${INBOX_BRANCH}*`;
}

export interface SubmittedCounts {
  /** Changes with `state: submitted` on the pending branch as last fetched. */
  submitted: number;
  /** Of them, the user's own; see {@link submitters}. */
  mine: number;
  /** Delivery Groups with at least one blocked change. */
  blocked: number;
}

/** A submitted change awaiting publication, as the session line and Studio show it. */
export interface PendingSubmittedChange {
  name: string;
  /** The deliveries as `repository@branch`, space-joined; empty when none names a branch. */
  group: string;
  blocked: boolean;
  /** The user's own; see {@link submitters}. */
  mine: boolean;
  /** Who submitted it, by the pending branch's history; absent when Git cannot say. */
  author?: string;
}

/** Who submitted a change folder, as {@link submitters} reads it. */
export interface Submitter {
  mine: boolean;
  author?: string;
}

/** Longer than the other reads: the walk reads the inbox's history. */
const AUTHOR_TIMEOUT_MS = 5_000;

/**
 * Commit authors by change folder (`<source>/<name>`): the newest commit on `ref` that added the
 * folder's Delivery Record, so a change dropped and submitted again names its latest submitter.
 * One `git log`; empty when Git fails or times out.
 */
async function submittedAuthors(
  companionPath: string,
  ref: string,
  folders: readonly string[],
): Promise<Map<string, { name: string; email: string }>> {
  const authors = new Map<string, { name: string; email: string }>();
  if (folders.length === 0) return authors;
  const log = await gitText(
    companionPath,
    [
      "log",
      "--diff-filter=A",
      "--no-renames",
      "-z",
      "--format=%x01%an%x02%ae",
      "--name-only",
      "--end-of-options",
      ref,
      "--",
      ...folders.map((folder) => `${folder}/${DELIVERY_FILE}`),
    ],
    { timeoutMs: AUTHOR_TIMEOUT_MS, globals: ["--literal-pathspecs"] },
  );
  if (log === null) return authors;
  // Per commit: `\x01<name>\x02<email>\0\n<path>\0<path>\0…`, newest first.
  for (const commit of log.split("\x01").slice(1)) {
    const [header = "", ...files] = commit.split("\0");
    const [name = "", email = ""] = header.split("\x02");
    for (const file of files) {
      const folder = path.posix.dirname(file.replace(/^\n/, ""));
      if (file.trim() && !authors.has(folder)) authors.set(folder, { name, email });
    }
  }
  return authors;
}

/**
 * Whose submitted change folders on `ref` are the user's own: committed with the companion's Git
 * `user.email` (any machine of theirs), or recorded as submitted from this checkout (`local`),
 * which also covers a machine whose email differs. A display hint, never a permission.
 */
export async function submitters(
  companionPath: string,
  ref: string,
  folders: readonly string[],
  local: Readonly<Record<string, unknown>> = {},
): Promise<Map<string, Submitter>> {
  const [authors, configured] = await Promise.all([
    submittedAuthors(companionPath, ref, folders),
    gitText(companionPath, ["config", "--get", "user.email"]),
  ]);
  const email = configured?.trim().toLowerCase();
  return new Map(
    folders.map((folder) => {
      const author = authors.get(folder);
      const mine =
        folder in local ||
        (!!email && author !== undefined && author.email.toLowerCase() === email);
      return [folder, { mine, ...(author?.name ? { author: author.name } : {}) }];
    }),
  );
}

/** A Delivery Record's text as far as the count reads it; null when it does not parse. */
function recordSummary(
  text: string,
): { state?: unknown; blocked?: unknown; group: string; deliveryGroup: string | null } | null {
  try {
    const record = parse(text) as {
      state?: unknown;
      blocked?: unknown;
      deliveries?: Array<{ repository?: unknown; branch?: unknown }>;
    } | null;
    if (!record || typeof record !== "object") return null;
    const branches = (Array.isArray(record.deliveries) ? record.deliveries : []).filter(
      (entry) => typeof entry?.branch === "string" && entry.branch.length > 0,
    );
    const group = branches
      .map((entry) => `${String(entry.repository).toLowerCase()}@${String(entry.branch)}`)
      .toSorted()
      .join(" ");
    // As `deliveryGroupFor` names it, short of its scope preference.
    const first = branches.find(namesGroup);
    const deliveryGroup = first
      ? groupOf({ repository: String(first.repository), branch: String(first.branch) })
      : null;
    return { state: record.state, blocked: record.blocked, group, deliveryGroup };
  } catch {
    return null;
  }
}

/** Blob contents by `<rev>:<path>` spec, read in one `cat-file --batch`; missing ones left out. */
async function readBlobs(
  companionPath: string,
  specs: readonly string[],
): Promise<Map<string, string>> {
  const out = await gitBytes(companionPath, ["cat-file", "--batch"], {
    input: `${specs.join("\n")}\n`,
  });
  return (out && parseBlobBatch(out, specs)) ?? new Map();
}

/** Folder names directly below `dir` at `ref`; empty when Git fails. */
async function foldersAt(companionPath: string, ref: string, dir: string): Promise<string[]> {
  const listed = await gitText(companionPath, [
    "ls-tree",
    "-z",
    "-d",
    "--name-only",
    "--end-of-options",
    ref,
    "--",
    `${dir}/`,
  ]);
  return (
    (listed ?? "")
      .split("\0")
      // A name with a newline would split its line in `readBlobs`' batch; no change has one.
      .filter((entry) => entry && !entry.includes("\n"))
      .map((entry) => entry.split("/").at(-1)!)
  );
}

/** Blob ids by path below `dir` at `ref`, the Delivery Record left out; null when Git fails. */
async function blobsBelow(
  companionPath: string,
  ref: string,
  dir: string,
): Promise<Map<string, string> | null> {
  const listed = await gitText(companionPath, [
    "ls-tree",
    "-r",
    "-z",
    "--end-of-options",
    ref,
    "--",
    `${dir}/`,
  ]);
  if (listed === null) return null;
  const blobs = treeBlobs(nulPaths(listed), dir);
  blobs.delete(DELIVERY_FILE);
  return blobs;
}

/**
 * Submitted changes on the pending branch as last fetched, read with a few bounded local Git
 * commands off the caller's thread and no network, each with its block and submitter (`local`: the folders Mate's local
 * companion state records as submitted from this checkout). A change the default branch already
 * archived is left out. Says nothing about merge state; empty when nothing was
 * fetched or Git fails.
 */
export async function pendingSubmittedChanges(
  companionPath: string,
  local: Readonly<Record<string, unknown>> = {},
  layout: SubmittedLayout = OPENSPEC_LAYOUT,
): Promise<PendingSubmittedChange[]> {
  const changes = await groupedSubmittedChanges(companionPath, local, layout);
  return changes.map(({ deliveryGroup: _deliveryGroup, ...change }) => change);
}

interface GroupedSubmittedChange extends PendingSubmittedChange {
  /**
   * Its Delivery Group as `mate artifact pending` names it, after its first recorded branch;
   * `change/<name>` without one.
   */
  deliveryGroup: string;
}

async function groupedSubmittedChanges(
  companionPath: string,
  local: Readonly<Record<string, unknown>>,
  layout: SubmittedLayout,
): Promise<GroupedSubmittedChange[]> {
  const refs = await trackingRefs(companionPath);
  if (!refs) return [];
  const ref = refs.pendingRef;
  // A type without an archive lists none here: its inbox folders count until they are cleared.
  const { archiveRoot } = layout;
  const names = (await foldersAt(companionPath, ref, layout.source)).filter(
    (name) =>
      isSubmittedName(name) &&
      (archiveRoot === undefined ||
        path.posix.dirname(archiveRoot) !== layout.source ||
        name !== path.posix.basename(archiveRoot)),
  );
  if (names.length === 0) return [];
  const specs = names.map((name) => `${ref}:${layout.source}/${name}/${DELIVERY_FILE}`);
  const [blobs, archives] = await Promise.all([
    readBlobs(companionPath, specs),
    archiveRoot === undefined ? [] : foldersAt(companionPath, refs.defaultRef, archiveRoot),
  ]);
  const sameBlob = async (a: string, b: string): Promise<boolean> => {
    const texts = await readBlobs(companionPath, [a, b]);
    const [mine, theirs] = [texts.get(a), texts.get(b)];
    return mine !== undefined && theirs !== undefined && sameTextBesidesLineEndings(mine, theirs);
  };
  // Published, but the inbox was not emptied yet; as `publishedAs` decides.
  const isPublished = async (name: string): Promise<boolean> => {
    const ids = archives.filter((id) => layout.recordName(id) === name);
    if (ids.length === 0) return false;
    const source = await blobsBelow(companionPath, ref, `${layout.source}/${name}`);
    const archived = (id: string) =>
      blobsBelow(companionPath, refs.defaultRef, `${archiveRoot}/${id}`);
    return (await matchingArchive(ids, source, archived, sameBlob)) !== null;
  };
  const submitted = names.flatMap((name, index) => {
    const text = blobs.get(specs[index]!);
    const record = text === undefined ? null : recordSummary(text);
    return record?.state === "submitted" ? [{ name, record }] : [];
  });
  // Only a name with an archive runs Git.
  const published = await Promise.all(submitted.map(({ name }) => isPublished(name)));
  const pending: Omit<GroupedSubmittedChange, "mine" | "author">[] = submitted
    .filter((_, index) => !published[index])
    .map(({ name, record }) => ({
      name,
      group: record.group,
      deliveryGroup: record.deliveryGroup ?? `change/${name}`,
      blocked: Boolean(record.blocked),
    }));
  if (pending.length === 0) return [];
  const folderOf = (name: string): string => `${layout.source}/${name}`;
  const who = await submitters(
    companionPath,
    ref,
    pending.map((change) => folderOf(change.name)),
    local,
  );
  return pending.map((change) => ({ ...change, mine: false, ...who.get(folderOf(change.name)) }));
}

/** {@link pendingSubmittedChanges} as counts; a group is blocked once, however many changes are. */
export async function pendingSubmittedCounts(
  companionPath: string,
  local: Readonly<Record<string, unknown>> = {},
  layout: SubmittedLayout = OPENSPEC_LAYOUT,
): Promise<SubmittedCounts> {
  const changes = await groupedSubmittedChanges(companionPath, local, layout);
  const blocked = new Set(
    changes.filter((change) => change.blocked).map((change) => change.deliveryGroup),
  );
  return {
    submitted: changes.length,
    mine: changes.filter((change) => change.mine).length,
    blocked: blocked.size,
  };
}

/**
 * The short operator line: how many submitted changes await publication, how many are the
 * user's own, and the blocked groups; null for none. Studio lists them.
 */
export async function pendingSubmittedLine(
  companionPath: string,
  homeDir?: string,
): Promise<string | null> {
  const { submitted, mine, blocked } = await pendingSubmittedCounts(
    companionPath,
    readSubmittedFolders(companionPath, homeDir),
  );
  if (submitted === 0) return null;
  return [
    `${submitted} submitted awaiting publication`,
    ...(mine > 0 ? [`${mine} yours`] : []),
    ...(blocked > 0 ? [`${blocked} group${blocked === 1 ? "" : "s"} blocked`] : []),
  ].join(" · ");
}
