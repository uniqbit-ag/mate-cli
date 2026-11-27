import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import {
  type CompanionGit,
  companionGit,
  LITERAL_PATHSPECS,
  nulPaths,
} from "../../runtime/companion-git";
import {
  readSubmittedFolders,
  type SubmittedFolder,
  updateSubmittedFolders,
} from "../../runtime/companion-git-state";
import { withPathLock } from "../../runtime/companion-lock";
import type { PublicationSecretScan } from "../../runtime/publication-secret-scan";
import {
  blobDigest,
  contentDigest,
  folderDigest,
  ownFiles,
} from "../../runtime/submitted-arrivals";
import { SCHEMA_ARTIFACTS, type MateSchema } from "../delivery/stages";
import type { ArtifactType } from "../delivery/staging/artifact-type";
import {
  commitToPending,
  type PendingCommitDeps,
  type PendingCommitFailure,
} from "../delivery/staging/pending-edit";
import {
  defaultRef,
  fetchPendingBranches,
  pendingPlace,
  pendingRef,
  stagingRemote,
  type StagingRemote,
} from "../delivery/staging/refs";
import { defaultArtifactType } from "../delivery/staging/registry";
import { OWNER_FILE, type OwnerRead, parseOwner } from "./claims";
import {
  fetchedAt,
  type GitFailure,
  hashFiles,
  isGitBacked,
  readBlob,
  refCommit,
  treeBlobs,
  workGit,
} from "./git-transaction";
import {
  type ChangeLinks,
  branchesFrom,
  dependsOnFrom,
  deriveGroups,
  LINK_ARTIFACTS,
} from "./groups";
import { activeMembers, implicitRecord, type InventoryWorkset } from "./inventory";
import type { SharingFacts, SyncState } from "./projection";

/**
 * The team backlog is the companion's Pending Branch, the inbox `mate/inbox`: shared changes
 * sit there `state: active` beside submitted ones. Reads use the local tracking ref; only an
 * explicit refresh fetches, and the inbox is never merged into the checkout. Share, Claim and
 * Release commit through submit's pending-branch transaction and never touch the checkout;
 * Share records what it pushed in Mate's local companion state, as submit does.
 */

const WORK_LOCK = "work";

/** Git, scan, artifact type and state home for the pending-branch transaction; tests swap them. */
export interface WorkGitDeps {
  git?: (cwd: string) => CompanionGit;
  artifactType?: ArtifactType;
  scan?: (root: string, paths: string[], policyPath: string) => Promise<PublicationSecretScan>;
  stateHome?: string;
  tmpRoot?: string;
}

/** Bounds one pending-branch transaction, fetch, temporary worktree and push included. */
const PENDING_BUDGET_MS = 120_000;

export const pendingGit = (cwd: string): CompanionGit =>
  companionGit(cwd, { prompt: "never", budgetMs: PENDING_BUDGET_MS });

/** The pending-branch transaction's deps from Work's. */
export function pendingCommitDeps(
  gitFor: (cwd: string) => CompanionGit,
  type: ArtifactType,
  deps: WorkGitDeps,
): PendingCommitDeps {
  return {
    git: gitFor,
    artifactType: type,
    ...(deps.scan ? { scan: deps.scan } : {}),
    ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}),
  };
}

/** Folder of change `name` relative to the companion. */
export function folderOf(type: ArtifactType, name: string): string {
  return `${type.source}/${name}`;
}

// Discovery ---------------------------------------------------------------------------

/** The shared branch as Work names it. */
export interface SharedBranch {
  remote: string;
  /** The Pending Branch, `mate/inbox`. */
  branch: string;
  trackingRef: string;
  /** The default branch's tracking ref, where published archives are read. */
  defaultRef: string;
}

export interface TeamStatus {
  shared: SharedBranch | null;
  /** The inbox tip as last fetched; null before anything was shared or fetched. */
  tip: string | null;
  fetchedAt?: string;
  /** The last refresh in this process failed; placement is the last known one. */
  failure?: GitFailure;
  stale: boolean;
}

export interface RemoteChange {
  /** Companion-relative path → blob id. */
  files: Map<string, string>;
  links: ChangeLinks;
  owner: OwnerRead;
  /** As its Delivery Record on the inbox says. */
  state: "active" | "submitted";
}

export interface RemoteBacklog {
  status: TeamStatus;
  changes: Map<string, RemoteChange>;
  /** Change names the default branch published as archives. */
  archived: Set<string>;
}

function emptyBacklog(status: TeamStatus): RemoteBacklog {
  return { status, changes: new Map(), archived: new Set() };
}

function sharedOf(remote: StagingRemote): SharedBranch {
  return {
    remote: remote.remote,
    branch: remote.pendingBranch,
    trackingRef: pendingRef(remote),
    defaultRef: defaultRef(remote),
  };
}

const NO_UPSTREAM: GitFailure = {
  kind: "no-remote",
  message: "the companion has no upstream to share with",
};

const NOT_GIT: GitFailure = { kind: "no-remote", message: "the companion is not a Git repository" };

/** A change's state as its Delivery Record on the inbox says; none counts as active. */
export function stateOf(delivery: string | null): RemoteChange["state"] | "dropped" {
  const state = delivery ? /^state:\s*(\w+)\s*$/m.exec(delivery)?.[1] : undefined;
  if (state === "submitted" || state === "dropped") return state;
  return "active";
}

/** Names of the published records below the type's archive root at `commit`. */
async function archivedNames(
  git: CompanionGit,
  commit: string,
  type: ArtifactType,
): Promise<Set<string>> {
  const listed = await git.run(["ls-tree", "-z", "--name-only", `${commit}:${type.archiveRoot}`]);
  const names = new Set<string>();
  if (listed.status !== 0) return names;
  for (const id of nulPaths(listed.stdout)) {
    if (type.isRecordId(id)) names.add(type.recordName(id));
  }
  return names;
}

/** The backlog from local refs; no network. `lastFailure` is the failed refresh to report. */
export async function readTeamBacklog(
  companionPath: string,
  lastFailure?: GitFailure,
  type: ArtifactType = defaultArtifactType(),
): Promise<RemoteBacklog> {
  const git = workGit(companionPath);
  if (!(await isGitBacked(git))) {
    return emptyBacklog({ shared: null, tip: null, failure: NOT_GIT, stale: true });
  }
  const remote = await stagingRemote(git);
  if (!remote) return emptyBacklog({ shared: null, tip: null, failure: NO_UPSTREAM, stale: true });
  const shared = sharedOf(remote);
  const [tip, published, at] = await Promise.all([
    refCommit(git, shared.trackingRef),
    refCommit(git, shared.defaultRef),
    fetchedAt(git, shared.trackingRef),
  ]);
  const status: TeamStatus = {
    shared,
    tip,
    ...(at ? { fetchedAt: at } : {}),
    ...(lastFailure ? { failure: lastFailure } : {}),
    // A fetched remote without an inbox has nothing shared yet; that is not stale.
    stale: !!lastFailure || (!tip && !published),
  };
  const backlog = emptyBacklog(status);
  if (published) backlog.archived = await archivedNames(git, published, type);
  if (!tip) return backlog;
  const files = new Map<string, Map<string, string>>();
  for (const [file, { blob }] of await treeBlobs(git, tip, [type.source])) {
    const parts = file.slice(type.source.length + 1).split("/");
    if (parts.length < 2) continue;
    const name = parts[0]!;
    if (folderOf(type, name) === type.archiveRoot) continue;
    const entry = files.get(name) ?? new Map<string, string>();
    entry.set(file, blob);
    files.set(name, entry);
  }
  await Promise.all(
    [...files].map(async ([name, blobs]) => {
      const read = (relative: string) => {
        const blob = blobs.get(`${folderOf(type, name)}/${relative}`);
        return blob ? readBlob(git, blob) : Promise.resolve(null);
      };
      const [artifacts, delivery, owner] = await Promise.all([
        Promise.all(LINK_ARTIFACTS.map(read)),
        read(type.deliveryFile),
        read(OWNER_FILE),
      ]);
      const state = stateOf(delivery);
      if (state === "dropped") return;
      backlog.changes.set(name, {
        files: blobs,
        links: { name, dependsOn: dependsOnFrom(artifacts), branches: branchesFrom(delivery) },
        owner: parseOwner(owner),
        state,
      });
    }),
  );
  return backlog;
}

/** Explicit Refresh: one bounded fetch of the default branch and the inbox; never merges. */
export async function refreshTeam(
  companionPath: string,
): Promise<{ status: TeamStatus } | { failure: GitFailure }> {
  const git = workGit(companionPath);
  if (!(await isGitBacked(git))) return { failure: NOT_GIT };
  const remote = await stagingRemote(git);
  if (!remote) return { failure: NO_UPSTREAM };
  const fetched = await fetchPendingBranches(git, remote);
  if ("error" in fetched) {
    return { failure: { kind: fetched.transient ? "offline" : "failed", message: fetched.error } };
  }
  const shared = sharedOf(remote);
  const [tip, at] = await Promise.all([
    refCommit(git, shared.trackingRef),
    fetchedAt(git, shared.trackingRef),
  ]);
  return { status: { shared, tip, ...(at ? { fetchedAt: at } : {}), stale: false } };
}

// Shareable files ---------------------------------------------------------------------

const SECRET_PATH =
  /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.\w+)?)$|\.(pem|key|p12|pfx)$/i;

export interface ChangeFiles {
  /** Companion-relative POSIX paths Share would push: what submit copies, the owner file left out. */
  files: string[];
  excluded: { path: string; reason: string }[];
  /** Reasons that refuse the share outright. */
  refusals: string[];
}

/** Every regular file below `root`, relative POSIX paths; for a companion outside Git. */
async function walkFiles(root: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    // oxlint-disable-next-line no-await-in-loop -- bounded change folder, walked in order
    if (entry.isDirectory()) found.push(...(await walkFiles(root, relative)));
    else found.push(relative);
  }
  return found;
}

/**
 * The files of a local change Share would push: the ones its Git would add (tracked and
 * untracked, ignored ones left out), as submit copies them, without the owner file, which only
 * Claim and Release change. Links, nested repositories and secret-looking paths refuse it.
 */
export async function changeFiles(
  companionPath: string,
  change: string,
  type: ArtifactType = defaultArtifactType(),
): Promise<ChangeFiles> {
  const result: ChangeFiles = { files: [], excluded: [], refusals: [] };
  const folder = folderOf(type, change);
  const root = path.join(companionPath, ...folder.split("/"));
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat) return result;
  if (!rootStat.isDirectory()) {
    result.refusals.push(`${folder} is not a regular directory`);
    return result;
  }
  const listed = await workGit(companionPath).run([
    ...LITERAL_PATHSPECS,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    `${folder}/`,
  ]);
  const relatives =
    listed.status === 0
      ? nulPaths(listed.stdout).map((file) => file.slice(folder.length + 1))
      : await walkFiles(root);
  for (const relative of [...new Set(relatives)].toSorted()) {
    const companionRelative = `${folder}/${relative.replace(/\/$/, "")}`;
    if (relative.endsWith("/")) {
      result.refusals.push(`${companionRelative} is a nested Git repository`);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a handful of files per change
    const stat = await fs.lstat(path.join(root, ...relative.split("/"))).catch(() => null);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      result.refusals.push(`${companionRelative} is a symbolic link`);
    } else if (!stat.isFile()) {
      result.refusals.push(`${companionRelative} is not a regular file`);
    } else if (SECRET_PATH.test(relative)) {
      result.refusals.push(`${companionRelative} looks like a secret and is never shared`);
    } else if (relative === OWNER_FILE) {
      result.excluded.push({
        path: companionRelative,
        reason: "changed only by Claim and Release",
      });
    } else {
      result.files.push(companionRelative);
    }
  }
  return result;
}

// Comparison --------------------------------------------------------------------------

/** Companion-relative `[path, blob]` entries of `folder`, relative to it, the owner file left out. */
function sharedEntries(
  folder: string,
  entries: Iterable<readonly [string, string]>,
): [string, string][] {
  return [...entries]
    .map(([file, blob]): [string, string] => [file.slice(folder.length + 1), blob])
    .filter(([relative]) => relative !== OWNER_FILE);
}

/** A member's shared files at the inbox tip, the owner file left out, relative to its folder. */
function remoteShared(
  backlog: RemoteBacklog,
  type: ArtifactType,
  member: string,
): [string, string][] {
  return sharedEntries(folderOf(type, member), backlog.changes.get(member)?.files ?? []);
}

/** A member's shareable local files with their blob ids, relative to its folder. */
async function localShared(
  git: CompanionGit,
  companionPath: string,
  type: ArtifactType,
  member: string,
): Promise<[string, string][]> {
  const listed = await changeFiles(companionPath, member, type);
  const blobs = await hashFiles(git, companionPath, listed.files);
  const prefix = `${folderOf(type, member)}/`;
  return listed.files.map((file): [string, string] => [
    file.slice(prefix.length),
    blobs.get(file) ?? "",
  ]);
}

/**
 * One member against the inbox, from the local folder L, the folder at the inbox tip T and the
 * digest D this checkout recorded when it last pushed or took it.
 */
function memberSync(local: string, remote: string, recorded: string | undefined): SyncState {
  if (local === remote) return "in-sync";
  if (recorded === remote) return "ahead";
  if (recorded === local) return "behind";
  return "diverged";
}

function combine(states: readonly SyncState[]): SyncState {
  if (states.includes("diverged")) return "diverged";
  const ahead = states.includes("ahead");
  const behind = states.includes("behind");
  if (ahead && behind) return "diverged";
  if (ahead) return "ahead";
  return behind ? "behind" : "in-sync";
}

/** How one Workset relates to the shared branch. */
export async function compareWorkset(
  companionPath: string,
  entry: InventoryWorkset,
  backlog: RemoteBacklog,
  deps: Pick<WorkGitDeps, "artifactType" | "stateHome"> = {},
): Promise<SharingFacts> {
  const type = deps.artifactType ?? defaultArtifactType();
  const members = activeMembers(entry);
  const shared = members.filter((member) => backlog.changes.has(member));
  const stale = backlog.status.stale;
  if (shared.length === 0) {
    const unknown = !backlog.status.tip && !!backlog.status.failure && !!backlog.status.shared;
    return {
      presence: unknown ? "unknown" : "local",
      missingMembers: [],
      sync: "in-sync",
      stale,
      remoteOnly: false,
    };
  }
  const git = workGit(companionPath);
  const recorded = readSubmittedFolders(companionPath, deps.stateHome);
  const states: SyncState[] = [];
  let localFiles = 0;
  for (const member of shared) {
    // oxlint-disable-next-line no-await-in-loop -- few members per Workset
    const local = await localShared(git, companionPath, type, member);
    if (local.length === 0) continue;
    localFiles += local.length;
    states.push(
      memberSync(
        blobDigest(local),
        blobDigest(remoteShared(backlog, type, member)),
        recorded[folderOf(type, member)]?.shared,
      ),
    );
  }
  const missing = members.filter((member) => !backlog.changes.has(member));
  return {
    presence: missing.length > 0 ? "partial" : "shared",
    missingMembers: missing,
    sync: combine(states),
    stale,
    remoteOnly: localFiles === 0,
  };
}

// Preview -----------------------------------------------------------------------------

export interface SharePreview {
  workset: string;
  members: string[];
  /** Approved files with their local blob ids. */
  files: { path: string; blob: string }[];
  excluded: { path: string; reason: string }[];
  /** Active changes this Workset depends on that are neither shared, published nor included. */
  externalDependencies: string[];
  included: string[];
  target: { remote: string; branch: string };
  problems: string[];
  /** Binds the confirmation to exactly this content. */
  hash: string;
}

export type PreviewResult = { preview: SharePreview } | { refusal: string };

async function readSchema(changeDir: string): Promise<MateSchema | null> {
  try {
    const document = parse(await fs.readFile(path.join(changeDir, ".openspec.yaml"), "utf8")) as {
      schema?: unknown;
    } | null;
    const schema = document?.schema;
    return typeof schema === "string" && schema in SCHEMA_ARTIFACTS ? (schema as MateSchema) : null;
  } catch {
    return null;
  }
}

const ARTIFACT_FILE: Record<string, (files: string[], prefix: string) => boolean> = {
  proposal: (files, prefix) => files.includes(`${prefix}/proposal.md`),
  design: (files, prefix) => files.includes(`${prefix}/design.md`),
  tasks: (files, prefix) => files.includes(`${prefix}/tasks.md`),
  specs: (files, prefix) => files.some((file) => file.startsWith(`${prefix}/specs/`)),
};

/**
 * Why each change is not ready to share: refused files, and for OpenSpec the artifacts its
 * schema requires; another artifact type answers through its own `check`.
 */
export async function planProblems(
  companionPath: string,
  members: readonly string[],
  type: ArtifactType = defaultArtifactType(),
): Promise<string[]> {
  const problems: string[] = [];
  const openspec = type.name === defaultArtifactType().name;
  for (const change of members) {
    const prefix = folderOf(type, change);
    // oxlint-disable-next-line no-await-in-loop -- few members per Workset
    const [schema, listed] = await Promise.all([
      readSchema(path.join(companionPath, ...prefix.split("/"))),
      changeFiles(companionPath, change, type),
    ]);
    problems.push(...listed.refusals);
    if (!openspec) {
      // oxlint-disable-next-line no-await-in-loop -- same change
      const refused = await type.check(companionPath, change);
      if (refused) problems.push(`${change}: ${refused}`);
      continue;
    }
    if (!schema) {
      problems.push(`${change} names no known schema in .openspec.yaml`);
      continue;
    }
    for (const artifact of SCHEMA_ARTIFACTS[schema]) {
      if (!ARTIFACT_FILE[artifact]?.(listed.files, prefix)) {
        problems.push(`${change} lacks its ${artifact} artifact`);
      }
    }
  }
  return problems;
}

async function localArchived(
  companionPath: string,
  name: string,
  type: ArtifactType,
): Promise<boolean> {
  if (type.archiveRoot === undefined) return false;
  const dir = path.join(companionPath, ...type.archiveRoot.split("/"));
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.some((id) => type.isRecordId(id) && type.recordName(id) === name);
}

async function localDependsOn(
  companionPath: string,
  change: string,
  type: ArtifactType,
): Promise<string[]> {
  const dir = path.join(companionPath, ...folderOf(type, change).split("/"));
  const sources = await Promise.all(
    LINK_ARTIFACTS.map((artifact) =>
      fs.readFile(path.join(dir, artifact), "utf8").catch(() => null),
    ),
  );
  return dependsOnFrom(sources);
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface PreviewOptions {
  /** External active dependencies the person explicitly includes. */
  include?: readonly string[];
  artifactType?: ArtifactType;
}

/** What Share would transmit; reads local refs only and writes nothing. */
export async function previewShare(
  companionPath: string,
  entry: InventoryWorkset,
  backlog: RemoteBacklog,
  options: PreviewOptions = {},
): Promise<PreviewResult> {
  const type = options.artifactType ?? defaultArtifactType();
  if (!entry.actionable) {
    return { refusal: entry.diagnostics[0] ?? "this Workset cannot be shared" };
  }
  const shared = backlog.status.shared;
  if (!shared) {
    return { refusal: backlog.status.failure?.message ?? "the companion has no shared branch" };
  }
  const members = activeMembers(entry);
  if (members.length === 0) {
    return { refusal: "Scratchpad ideas are not shared; propose the change first" };
  }

  const excluded: SharePreview["excluded"] = [];
  const files: string[] = [];
  const included = [...new Set(options.include ?? [])].filter((name) => !members.includes(name));
  const changes = [...members, ...included];
  for (const change of changes) {
    // oxlint-disable-next-line no-await-in-loop -- few members per Workset
    const listed = await changeFiles(companionPath, change, type);
    if (listed.refusals.length > 0) return { refusal: listed.refusals.join("; ") };
    if (listed.files.length === 0) return { refusal: `${change} has no files to share` };
    excluded.push(...listed.excluded);
    files.push(...listed.files);
  }
  const problems = await planProblems(companionPath, changes, type);
  const external: string[] = [];
  for (const change of changes) {
    // oxlint-disable-next-line no-await-in-loop -- few members per Workset
    for (const dependency of await localDependsOn(companionPath, change, type)) {
      if (changes.includes(dependency)) continue;
      if (backlog.archived.has(dependency) || backlog.changes.has(dependency)) continue;
      // oxlint-disable-next-line no-await-in-loop -- rare
      if (await localArchived(companionPath, dependency, type)) continue;
      external.push(dependency);
    }
  }
  const blobs = await hashFiles(workGit(companionPath), companionPath, files);
  const fileList = files
    .map((file) => ({ path: file, blob: blobs.get(file) ?? "" }))
    .toSorted((a, b) => a.path.localeCompare(b.path));
  const target = { remote: shared.remote, branch: shared.branch };
  const hash = contentHash({
    workset: entry.id,
    members,
    included,
    files: fileList,
    remote: changes.map((change) => [change, blobDigest(remoteShared(backlog, type, change))]),
    target,
  });
  return {
    preview: {
      workset: entry.id,
      members,
      files: fileList,
      excluded,
      externalDependencies: [...new Set(external)],
      included,
      target,
      problems,
      hash,
    },
  };
}

// Transactions ------------------------------------------------------------------------

/** Runs one Work transaction at a time per companion. */
export async function withWorkLock<T>(
  companionPath: string,
  run: () => Promise<T>,
): Promise<T | { status: "refused"; reason: string }> {
  const locked = await withPathLock(WORK_LOCK, companionPath, { timeoutMs: 15_000 }, run);
  return locked.acquired
    ? locked.value
    : { status: "refused", reason: "another Work operation is running on this companion" };
}

export type TransactionFailure =
  | { status: "stale"; reason: string }
  | { status: "refused"; reason: string }
  | { status: "failed"; failure: GitFailure };

/** A pending-branch transaction that pushed nothing, as Work reports it. */
export function transactionFailure(result: PendingCommitFailure): TransactionFailure {
  switch (result.reason) {
    case "no-remote":
      return { status: "refused", reason: NO_UPSTREAM.message };
    case "secret":
      return {
        status: "refused",
        reason: `a file looks like it holds a secret: ${result.secretFindings
          .map((finding) => `${finding.path}:${finding.line} (${finding.ruleId})`)
          .join(", ")}`,
      };
    case "conflict":
      return { status: "stale", reason: `${result.detail}; refresh and confirm again` };
    case "not-permitted":
      return { status: "failed", failure: { kind: "protected", message: result.detail } };
    case "fetch-failed":
      return { status: "failed", failure: { kind: "offline", message: result.detail } };
    default:
      return { status: "failed", failure: { kind: "failed", message: result.detail } };
  }
}

/** The folder's content digest at `dir`, the Delivery Record left out: what submit compares. */
export async function pendingContent(
  dir: string,
  folder: string,
  type: ArtifactType,
  git: CompanionGit,
): Promise<string | null> {
  const files = await ownFiles(git, dir, folder);
  if (!files || files.length === 0) return null;
  return folderDigest(
    path.join(dir, ...folder.split("/")),
    files.filter((file) => file !== type.deliveryFile),
  );
}

/** Records `content` for folders this checkout already recorded; others stay unrecorded. */
export function recordPendingContent(
  companionPath: string,
  contents: ReadonlyMap<string, string>,
  stateHome?: string,
): void {
  const recorded = readSubmittedFolders(companionPath, stateHome);
  const updates: Record<string, SubmittedFolder> = {};
  for (const [folder, content] of contents) {
    const entry = recorded[folder];
    if (entry) updates[folder] = { ...entry, content };
  }
  if (Object.keys(updates).length > 0)
    updateSubmittedFolders(companionPath, updates, [], stateHome);
}

// Confirmed share ---------------------------------------------------------------------

export type ShareOutcome = { status: "shared"; commit: string } | TransactionFailure;

export interface ShareRequest {
  hash: string;
  include?: readonly string[];
  transactionId: string;
}

export interface ShareDeps extends WorkGitDeps {
  /** Re-reads the Workset after the fetch, so confirmation checks current local state. */
  inventoryEntry: () => Promise<InventoryWorkset | undefined>;
  now?: () => Date;
}

type ShareStop = Exclude<ShareOutcome, { status: "shared" }>;

/**
 * Shares the previewed Workset after the person confirmed it. Fetches first, recomputes the
 * preview and refuses when anything bound by its hash changed. Then pushes the files to the
 * inbox in one commit, each folder's owner file kept as the inbox has it, and records what
 * it pushed. Records no claim; the checkout is not touched.
 */
export async function confirmShare(
  companionPath: string,
  request: ShareRequest,
  deps: ShareDeps,
): Promise<ShareOutcome> {
  const type = deps.artifactType ?? defaultArtifactType();
  return withWorkLock(companionPath, async (): Promise<ShareOutcome> => {
    const refreshed = await refreshTeam(companionPath);
    if ("failure" in refreshed) return { status: "failed", failure: refreshed.failure };
    const entry = await deps.inventoryEntry();
    if (!entry) return { status: "stale", reason: "the Workset no longer exists locally" };
    const backlog = await readTeamBacklog(companionPath, undefined, type);
    const previewed = await previewShare(companionPath, entry, backlog, {
      include: request.include,
      artifactType: type,
    });
    if ("refusal" in previewed) return { status: "refused", reason: previewed.refusal };
    const { preview } = previewed;
    if (preview.hash !== request.hash) {
      return {
        status: "stale",
        reason: "the proposal or its shared version changed; review a new preview",
      };
    }
    if (preview.problems.length > 0) {
      return { status: "refused", reason: preview.problems.join("; ") };
    }
    if (preview.externalDependencies.length > 0) {
      return {
        status: "refused",
        reason: `depends on unshared active ${preview.externalDependencies.join(", ")}; include them or share them first`,
      };
    }
    const facts = await compareWorkset(companionPath, entry, backlog, deps);
    if (facts.sync === "behind" || facts.sync === "diverged") {
      return {
        status: "refused",
        reason: `the shared version has changes this checkout lacks; take it with \`mate artifact take\` first`,
      };
    }
    return pushShare(companionPath, request, preview, backlog, type, deps);
  });
}

async function pushShare(
  companionPath: string,
  request: ShareRequest,
  preview: SharePreview,
  backlog: RemoteBacklog,
  type: ArtifactType,
  deps: ShareDeps,
): Promise<ShareOutcome> {
  const gitFor = deps.git ?? pendingGit;
  const changes = [...preview.members, ...preview.included];
  // Exactly the previewed bytes; a file edited since the preview makes it stale.
  const bytes = new Map<string, Buffer>();
  for (const file of preview.files) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of files
    bytes.set(file.path, await fs.readFile(path.join(companionPath, ...file.path.split("/"))));
  }
  const current = await hashFiles(
    workGit(companionPath),
    companionPath,
    preview.files.map((file) => file.path),
  );
  const changed = preview.files.find((file) => current.get(file.path) !== file.blob);
  if (changed) {
    return {
      status: "stale",
      reason: `${changed.path} changed while sharing; review a new preview`,
    };
  }
  const confirmed = new Map(
    changes.map((change) => [change, blobDigest(remoteShared(backlog, type, change))]),
  );
  // Take and the arrival sync compare the whole local folder, its owner file included.
  const localDigests = new Map<string, string>();
  for (const change of changes) {
    const folder = folderOf(type, change);
    // oxlint-disable-next-line no-await-in-loop -- few members per Workset
    const own = await ownFiles(workGit(companionPath), companionPath, folder);
    if (!own) continue;
    // oxlint-disable-next-line no-await-in-loop -- same folder
    const digest = await folderDigest(path.join(companionPath, ...folder.split("/")), own);
    localDigests.set(folder, digest);
  }
  const recorded = new Map<string, SubmittedFolder>();
  const submittedAt = (deps.now?.() ?? new Date()).toISOString();
  const result = await commitToPending<ShareStop>(
    {
      companionPath,
      subject: `chore(${type.name}): share ${preview.workset}`,
      transaction: request.transactionId,
      edit: async (dir, remote) => {
        recorded.clear();
        const work = gitFor(dir);
        const folders: string[] = [];
        for (const change of changes) {
          const folder = folderOf(type, change);
          // oxlint-disable-next-line no-await-in-loop -- one folder at a time
          const there = await treeBlobs(work, "HEAD", [folder]);
          const theirs = blobDigest(
            sharedEntries(
              folder,
              [...there].map(([file, { blob }]): [string, string] => [file, blob]),
            ),
          );
          // A rebuild on a moved tip re-checks: only an unrelated commit may land first.
          if (theirs !== confirmed.get(change)) {
            return {
              stop: {
                status: "stale",
                reason: `${change} changed on ${pendingPlace(remote)} since the preview; review a new preview`,
              },
            };
          }
          const target = path.join(dir, ...folder.split("/"));
          // oxlint-disable-next-line no-await-in-loop -- same folder
          for (const name of await fs.readdir(target).catch(() => [] as string[])) {
            if (name === OWNER_FILE) continue;
            // oxlint-disable-next-line no-await-in-loop -- same folder
            await fs.rm(path.join(target, name), { recursive: true, force: true });
          }
          const pushed: [string, Buffer][] = [];
          const blobs: [string, string][] = [];
          for (const file of preview.files.filter((entry) => entry.path.startsWith(`${folder}/`))) {
            const relative = file.path.slice(folder.length + 1);
            const content = bytes.get(file.path)!;
            const written = path.join(target, ...relative.split("/"));
            // oxlint-disable-next-line no-await-in-loop -- one file at a time
            await fs.mkdir(path.dirname(written), { recursive: true });
            // oxlint-disable-next-line no-await-in-loop -- same file
            await fs.writeFile(written, content);
            pushed.push([relative, content]);
            blobs.push([relative, file.blob]);
          }
          // oxlint-disable-next-line no-await-in-loop -- same folder
          const content = await pendingContent(dir, folder, type, work);
          recorded.set(folder, {
            digest: localDigests.get(folder) ?? contentDigest(pushed),
            ...(content ? { content } : {}),
            shared: blobDigest(blobs),
            submittedAt,
          });
          folders.push(folder);
        }
        return folders;
      },
    },
    pendingCommitDeps(gitFor, type, deps),
  );
  if (result.status === "failed") return transactionFailure(result);
  if (result.status === "stopped") {
    return result.value ?? { status: "refused", reason: "the share was stopped" };
  }
  updateSubmittedFolders(companionPath, Object.fromEntries(recorded), [], deps.stateHome);
  if (result.status === "unchanged") {
    const tip = await refCommit(workGit(companionPath), pendingRef(result.remote));
    return { status: "shared", commit: tip ?? "" };
  }
  return { status: "shared", commit: result.commit };
}

// Remote-only work --------------------------------------------------------------------

/** Shared Worksets whose changes this checkout does not have, as inventory entries. */
export function remoteOnlyEntries(
  backlog: RemoteBacklog,
  localChanges: ReadonlySet<string>,
): InventoryWorkset[] {
  const remote = [...backlog.changes.values()]
    .map((change) => change.links)
    .filter((links) => !localChanges.has(links.name));
  return deriveGroups(remote).map((group) => ({
    id: group.id,
    implicit: true,
    record: implicitRecord(group.id, group.members, []),
    members: group.members.map((name) => ({ name, kind: "active" as const })),
    diagnostics: group.diagnostics,
    actionable: group.diagnostics.length === 0,
  }));
}
