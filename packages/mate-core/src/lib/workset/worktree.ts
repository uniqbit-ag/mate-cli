import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { gitEnvironment, withoutAskPass } from "../../runtime/companion-git";
import { withCompanionLock } from "../../runtime/companion-lock";
import { errorMessage } from "../../runtime/error-message";
import { readGitLayout } from "../../runtime/git-layout";
import { repoLocalRegistryPath } from "../../runtime/repo-local";
import type { WrapRuntime } from "../../runtime/runtime-document-manifest";
import { readWrapState, WRAP_RUNTIMES } from "../../runtime/wrap-state";
import { cleanupWorkingRepository } from "../../tools/setup/working-repo-cleanup";
import { locateChange } from "../change-layout";
import { classifyBranch, configuredProtectedPatterns } from "../delivery/branches";
import { deliveryCheckout } from "../delivery/checkout";
import { type DeliveryRecord, readDeliveryRecord } from "../delivery/record";
import {
  newBranchBase,
  resolveDeliveryBranch,
  worktreeAddArgs,
  type BranchSource,
} from "../delivery/resolve-branch";
import { repositoryPath } from "../delivery/forge";
import { scopedRepositories } from "../openspec-scopes";
import { attendedLockOptions } from "../orchestrator/companion-git-sync";
import { readCompanionConfig } from "../orchestrator/config-store";
import {
  findRepoLocalLinkTo,
  readCompanionRegistry,
  writeRepoLocalRegistryEntry,
} from "../orchestrator/repository-link";
import { projectionEntries } from "../orchestrator/projection-entries";
import type { LinkedRepository } from "../orchestrator/types";
import { linkedCheckoutsOf, type EntryCheckout } from "../orchestrator/umbrella-checkouts";
import { runWrapPass } from "../orchestrator/wrap-pass";
import {
  indexWorktree,
  UMBRELLA_NOT_INDEXED,
  type IndexOutcome,
  type TokensaveRunner,
} from "./worktree-index";
import { findWorkset, readWorksets, resolveWorksetBranch, resolveWorksetOf } from "./record";

/**
 * Workset worktrees outside the factory: one Git worktree per Working Repository at
 * `<main checkout>.worktrees/<workset-id>`, on the Workset's Delivery Branch, linked to
 * the companion, wrapped like its main checkout and installed. Env files are reported by
 * path, never opened.
 */

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  /** Added to the promptless environment every command gets. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Written to standard input, which is then closed. */
  input?: string;
}

export type GitRunner = (
  cwd: string,
  args: string[],
  options?: GitRunOptions,
) => Promise<GitResult>;

/** Runs an install command; `stream` passes its output through, otherwise it is discarded. */
export type InstallRunner = (cwd: string, command: string[], stream: boolean) => Promise<boolean>;

/** Wraps the worktree for `runtimes`; resolves to the failure message, or null. */
export type WorktreeWrapper = (
  companionPath: string,
  repository: LinkedRepository,
  runtimes: readonly WrapRuntime[],
) => Promise<string | null>;

export interface WorktreeDeps {
  git?: GitRunner;
  install?: InstallRunner;
  writeLink?: typeof writeRepoLocalRegistryEntry;
  readWrapState?: typeof readWrapState;
  wrap?: WorktreeWrapper;
  unwrap?: typeof cleanupWorkingRepository;
  tokensave?: TokensaveRunner;
  /** The process's working directory; a worktree holding it is kept. */
  cwd?: () => string;
}

export type InstallOutcome = "ok" | "failed" | "skipped";

export interface WrapOutcome {
  /** The runtimes the main checkout is wrapped for. */
  runtimes: WrapRuntime[];
  outcome: InstallOutcome;
  reason?: string;
}

export interface WorktreeRepositoryResult {
  repository: string;
  /** The main checkout the worktree belongs to. */
  checkout: string;
  path: string;
  branch: string;
  action: "created" | "reused";
  install: { command: string | null; outcome: InstallOutcome; reason?: string };
  wrap: WrapOutcome;
  /** The worktree's tokensave index; a failure only warns. */
  index: IndexOutcome;
  /** Env files of the main checkout the worktree lacks, relative to the repository root. */
  missingEnv: string[];
  /** Set when a step for this repository failed. */
  error?: string;
}

/** An Umbrella Repository's mirrored worktree, linked and wrapped like the umbrella. */
export interface UmbrellaWorktreeResult {
  /** The Umbrella Repository. */
  path: string;
  /** The mirrored worktree folder holding the children's worktrees. */
  worktree: string;
  action: "created" | "reused";
  /** The children whose worktree the folder holds, as `org/repository`. */
  repositories: string[];
  wrap: WrapOutcome;
  /** The folder's tokensave index, kept when the umbrella has one; a failure only warns. */
  index: IndexOutcome;
  /** Set when linking or wrapping the folder failed; its worktrees stay. */
  error?: string;
}

export interface WorktreeResult {
  workset: string;
  ok: boolean;
  repositories: WorktreeRepositoryResult[];
  /** Present only when a repository is an Umbrella Repository's child. */
  umbrella?: UmbrellaWorktreeResult;
  diagnostics: string[];
  warnings: string[];
}

export interface PruneEntry {
  workset: string;
  repository: string;
  path: string;
}

/** A Workset to prune: its id and the changes whose Delivery Records name its branches. */
export interface PruneTarget {
  id: string;
  changes: readonly string[];
}

/** An Umbrella Repository's mirrored worktree of a Workset. */
export interface PruneMirrorEntry {
  workset: string;
  umbrella: string;
  path: string;
}

export interface PruneResult {
  removed: PruneEntry[];
  kept: (PruneEntry & { reason: string })[];
  /** Present only when a pruned Workset has a mirrored umbrella worktree. */
  umbrellas?: {
    removed: PruneMirrorEntry[];
    kept: (PruneMirrorEntry & { reason: string })[];
  };
  warnings: string[];
}

/** Never prompts: worktree creation runs unattended, often under `--json`. */
function promptlessEnv(): NodeJS.ProcessEnv {
  return {
    ...withoutAskPass(gitEnvironment()),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  } as NodeJS.ProcessEnv;
}

const runGit: GitRunner = (cwd, args, options = {}) =>
  new Promise<GitResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Unbounded: a merge check pipes a whole `git log -p` range into `git patch-id`.
    const child = execFile(
      "git",
      args,
      { cwd, env: { ...promptlessEnv(), ...options.env }, maxBuffer: Infinity },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.input);
    }
    const { timeoutMs } = options;
    if (timeoutMs !== undefined) {
      // Resolved without awaiting `close`: an SSH grandchild may hold the pipes open.
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: 1, stdout: "", stderr: `git ${args[0]} timed out after ${timeoutMs} ms` });
      }, timeoutMs);
    }
  });

const FETCH_TIMEOUT_MS = 60_000;

/** `git fetch --prune origin`, bounded; SSH runs in batch mode unless the user set their own command. */
async function fetchOrigin(git: GitRunner, checkout: string): Promise<GitResult> {
  const ownSsh =
    Boolean(process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) ||
    (await git(checkout, ["config", "--get", "core.sshCommand"])).code === 0;
  return git(checkout, ["fetch", "--prune", "origin"], {
    env: ownSsh ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
    timeoutMs: FETCH_TIMEOUT_MS,
  });
}

/** Serialized with `mate wrap`, Session Prepare and every sync, which rewrite the same manifests. */
const runWrap: WorktreeWrapper = async (companionPath, repository, runtimes) => {
  const locked = await withCompanionLock(companionPath, attendedLockOptions(companionPath), () =>
    runWrapPass(companionPath, repository, { runtimes }),
  );
  if (!locked.acquired) return "another companion synchronization is still running";
  return locked.value.kind === "failed" ? locked.value.message : null;
};

const runInstall: InstallRunner = (cwd, [command, ...args], stream) =>
  new Promise((resolve) => {
    const child = spawn(command!, args, { cwd, stdio: stream ? "inherit" : "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });

/** First match wins, at the worktree root only: workspace managers install the whole repository. */
const LOCKFILES: [string, string[]][] = [
  ["bun.lock", ["bun", "install"]],
  ["bun.lockb", ["bun", "install"]],
  ["pnpm-lock.yaml", ["pnpm", "install"]],
  ["yarn.lock", ["yarn", "install"]],
  ["package-lock.json", ["npm", "ci"]],
];

/** The install skip reason of a repository whose worktree could not be created. */
export const NOT_CREATED = "worktree not created";

const ENV_NAME = /^\.env(\..+)?$/;
const ENV_EXAMPLE = /\.(example|sample|template|dist)$/;

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Real path when it exists; otherwise the nearest existing parent resolved, so macOS `/var` matches `/private/var`. */
async function canonical(candidate: string): Promise<string> {
  try {
    return await fs.realpath(candidate);
  } catch {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    return path.join(await canonical(parent), path.basename(candidate));
  }
}

function worktreePathFor(mainCheckout: string, worksetId: string): string {
  return path.join(
    path.dirname(mainCheckout),
    `${path.basename(mainCheckout)}.worktrees`,
    worksetId,
  );
}

interface WorktreeEntry {
  path: string;
  /** Short branch name, or null when detached or bare. */
  branch: string | null;
  /** `git worktree lock` set; `git worktree remove` refuses it without `--force`. */
  locked: boolean;
  /** Set when Git marks the entry prunable (its directory or `.git` file is gone): Git's reason. */
  stale: string | null;
}

async function listWorktrees(git: GitRunner, repo: string): Promise<WorktreeEntry[] | null> {
  const result = await git(repo, ["worktree", "list", "--porcelain"]);
  if (result.code !== 0) return null;
  const entries = result.stdout.split(/\n\n+/).flatMap((block) => {
    let entryPath: string | null = null;
    let branch: string | null = null;
    let locked = false;
    let stale: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) entryPath = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/"))
        branch = line.slice("branch refs/heads/".length);
      else if (line === "locked" || line.startsWith("locked ")) locked = true;
      else if (line === "prunable" || line.startsWith("prunable ")) {
        stale = line.slice("prunable".length).trim() || "prunable";
      }
    }
    return entryPath ? [{ path: entryPath, branch, locked, stale }] : [];
  });
  return Promise.all(
    entries.map(async (entry) => ({ ...entry, path: await canonical(entry.path) })),
  );
}

/** A linked checkout; `umbrella` is set for an Umbrella Repository's child, whose id is the umbrella's. */
type LinkedCheckout = LinkedRepository & { umbrella?: string };

interface LinkedLookup {
  linked: LinkedCheckout | null;
  /** Registered paths that no longer exist. */
  missing: string[];
}

/** Every checkout linked to the companion, in lookup order, with its `org/repository`. */
interface LinkedIndex {
  checkouts: { linked: LinkedCheckout; identity: string | null }[];
  /** Registered paths that no longer exist. */
  missing: string[];
}

/** The first checkout in the index whose `origin` is the repository. */
function linkedCheckout(index: LinkedIndex, repository: string): LinkedLookup {
  // The first match in registry order decides, umbrella children in name order.
  const match = index.checkouts.find(
    ({ identity }) => identity?.toLowerCase() === repository.toLowerCase(),
  );
  return { linked: match?.linked ?? null, missing: index.missing };
}

/**
 * The existing registered checkouts, an Umbrella Repository's children included, then
 * the one the repo-local link holding `cwd` names, so an entry left naming a removed
 * folder does not hide it. Read once per run: expanding an umbrella reads every child's
 * `origin`.
 */
async function linkedIndex(
  companionPath: string,
  git: GitRunner,
  cwd: string,
): Promise<LinkedIndex> {
  let repos: LinkedRepository[] = [];
  try {
    repos = (await readCompanionRegistry(companionPath)).repos;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const present = await Promise.all(repos.map((repo) => exists(repo.path)));
  const current = await findRepoLocalLinkTo(cwd, companionPath);
  const entries = [...repos.filter((_, index) => present[index]), ...(current ? [current] : [])];
  const readOrigin = async (checkout: string) => {
    // Raw config, not `remote get-url`, so `insteadOf` rewrites do not change the identity.
    const remote = await git(checkout, ["config", "--get", "remote.origin.url"]);
    return remote.code === 0 ? remote.stdout.trim() || null : null;
  };
  const expanded = await Promise.all(
    entries.map(async (entry) =>
      Promise.all(
        (await linkedCheckoutsOf(entry, readOrigin, readOrigin)).map(async (checkout) => ({
          linked: { ...entry, ...(await mainChild(checkout)) },
          identity: checkout.remote ? repositoryPath(checkout.remote) : null,
        })),
      ),
    ),
  );
  return {
    checkouts: expanded.flat(),
    missing: repos.filter((_, at) => !present[at]).map((repo) => repo.path),
  };
}

/**
 * The checkout and umbrella an entry's checkout stands for. A child of a mirrored worktree
 * `<umbrella>.worktrees/<id>/<name>`, a worktree of `<umbrella>/<name>`, stands for that
 * main checkout, so the real umbrella stays the one mirrored.
 */
async function mainChild(checkout: EntryCheckout): Promise<{ path: string; umbrella?: string }> {
  const { path: child } = checkout;
  if (!checkout.umbrella) return { path: child };
  // Canonical, so an umbrella reached by a registry path and by Git's paths is one.
  const umbrella = await canonical(checkout.umbrella);
  const layout = readGitLayout(child);
  if (layout?.kind === "linked" && path.basename(layout.commonDir) === ".git") {
    const main = path.dirname(layout.commonDir);
    const real = await canonical(path.dirname(main));
    const mirrored =
      path.basename(main) === path.basename(child) &&
      (await canonical(worktreePathFor(real, path.basename(umbrella)))) === umbrella;
    if (mirrored) return { path: main, umbrella: real };
  }
  return { path: child, umbrella };
}

interface Plan {
  repository: string;
  /** The main checkout's Repository Link id, which the worktree's link repeats. */
  repositoryId: string;
  checkout: string;
  target: string;
  branch: string;
  source: BranchSource;
  /** Start point when `source` is `new`. */
  base?: string;
  reuse: boolean;
  /** `--take-branch`: `branch` is checked out in `checkout`, which is detached first. */
  take?: boolean;
  /** Set for an Umbrella Repository's child: the umbrella, whose mirrored worktree holds `target`. */
  umbrella?: string;
}

/** A resolved Workset: its id and the repositories that get a worktree. */
interface Target {
  id: string;
  repositories: readonly string[];
}

/** The explicit record with this id, or the diagnostics naming it and every invalid record. */
async function recordTarget(companionPath: string, worksetId: string): Promise<Target | string[]> {
  const { worksets, problems } = await readWorksets(companionPath);
  const record = worksets.find((entry) => entry.id === worksetId);
  if (record) return record;
  return [
    `no valid Workset ${worksetId}`,
    ...problems.map((problem) => `${problem.path}: ${problem.reason}`),
  ];
}

/**
 * The change's Workset as `mate artifact link` resolves it: the record listing it, else the
 * implicit single-change Workset with the repositories of the change's scopes.
 */
async function changeTarget(companionPath: string, change: string): Promise<Target | string[]> {
  const location = await locateChange(companionPath, change);
  if (!location || location.archived) return [`no active change ${change}`];
  const resolution = await resolveWorksetOf(companionPath, change);
  if (resolution.id === null) return resolution.diagnostics;
  if (!resolution.implicit) {
    const record = await findWorkset(companionPath, resolution.id);
    return record ?? [`no valid Workset ${resolution.id}`];
  }
  const repositories = await scopedRepositories(location.dir);
  if (repositories.length === 0) return [`change ${change} names no repository in its scopes`];
  return { id: resolution.id, repositories };
}

type ProtectedPatterns = readonly string[];

type PlanOptions = Pick<CreateWorktreesOptions, "ticket" | "takeBranch"> & {
  /** The companion's protected patterns, read once for every repository's take. */
  protectedPatterns?: ProtectedPatterns;
};

/** Phase 1: every check for every repository; any failure means nothing is created. */
async function planWorktrees(
  companionPath: string,
  target: Target,
  git: GitRunner,
  cwd: string,
  options: Pick<CreateWorktreesOptions, "ticket" | "takeBranch">,
): Promise<{ plans: Plan[]; mirror?: Mirror; diagnostics: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const index = await linkedIndex(companionPath, git, cwd);
  const planOptions: PlanOptions = options.takeBranch
    ? {
        ...options,
        protectedPatterns: configuredProtectedPatterns(
          (await readCompanionConfig(companionPath)).capabilities ?? [],
        ),
      }
    : options;
  const checked = await Promise.all(
    target.repositories.map((repository) =>
      planRepository(companionPath, target.id, repository, git, index, warnings, planOptions),
    ),
  );
  const plans = checked.filter((entry): entry is Plan => !Array.isArray(entry));
  const diagnostics = checked.flatMap((entry) => (Array.isArray(entry) ? entry : []));
  const mirror = await planMirror(companionPath, target.id, plans);
  if (Array.isArray(mirror)) return { plans, diagnostics: [...diagnostics, ...mirror], warnings };
  return { plans, ...(mirror ? { mirror } : {}), diagnostics, warnings };
}

/** The mirrored worktree a Workset's umbrella children get. */
interface Mirror {
  umbrella: string;
  /** The umbrella's Repository Link id, which the folder's link repeats. */
  repositoryId: string;
  folder: string;
  /** The folder already is this umbrella's mirrored worktree. */
  reuse: boolean;
}

/**
 * The mirrored worktree of the plans' Umbrella Repository, or the diagnostics that stop
 * the run: the folder must be this umbrella's mirrored worktree, or hold nothing but OS
 * metadata, Mate's material, and its children's reused worktrees, as a run interrupted
 * before linking leaves it.
 */
async function planMirror(
  companionPath: string,
  worksetId: string,
  plans: readonly Plan[],
): Promise<Mirror | string[] | undefined> {
  const children = plans.filter((plan) => plan.umbrella);
  const umbrellas = [...new Set(children.map((plan) => plan.umbrella!))];
  if (umbrellas.length === 0) return undefined;
  if (umbrellas.length > 1) {
    return [
      `the Workset spans the Umbrella Repositories ${umbrellas.join(", ")}; a mirrored worktree serves one`,
    ];
  }
  const umbrella = umbrellas[0]!;
  const repositoryId = children[0]!.repositoryId;
  const folder = await canonical(worktreePathFor(umbrella, worksetId));
  if (await isMirrorOf(folder, companionPath, repositoryId)) {
    return { umbrella, repositoryId, folder, reuse: true };
  }
  // A link of its own names another companion or id: someone else's folder.
  if (await exists(repoLocalRegistryPath(folder))) {
    return [`${folder} exists and is not the mirrored worktree of ${umbrella}`];
  }
  const listed = await fs.readdir(folder).catch(() => []);
  const material = mirrorMaterial();
  const reused = new Set(
    children.filter((plan) => plan.reuse).map((plan) => path.basename(plan.target)),
  );
  const foreign = listed.filter((name) => !material.has(name) && !reused.has(name));
  if (foreign.length === 0) return { umbrella, repositoryId, folder, reuse: false };
  return [`${folder} exists and is not the mirrored worktree of ${umbrella}`];
}

/** `folder` carries its own repo-local link to the companion under the umbrella's id. */
async function isMirrorOf(
  folder: string,
  companionPath: string,
  repositoryId: string,
): Promise<boolean> {
  const link = await findRepoLocalLinkTo(folder, companionPath);
  return link !== null && link.id === repositoryId && (await canonical(link.path)) === folder;
}

/** One repository's plan, or the diagnostics that stop the run. */
async function planRepository(
  companionPath: string,
  worksetId: string,
  repository: string,
  git: GitRunner,
  index: LinkedIndex,
  warnings: string[],
  { ticket, takeBranch, protectedPatterns }: PlanOptions,
): Promise<Plan | string[]> {
  const { linked, missing } = linkedCheckout(index, repository);
  if (!linked) {
    // An identity problem outranks the missing link.
    const identity = await resolveWorksetBranch(companionPath, worksetId, repository);
    if (identity.id === null) return identity.diagnostics.map((line) => `${repository}: ${line}`);
    const why = missing.map((entry) => `registered path ${entry} does not exist`).join("; ");
    return [
      `${repository}: not linked to ${companionPath} on this machine${why ? ` (${why})` : ""}`,
    ];
  }
  // Resolved after the fetch, so a branch pushed elsewhere counts as existing.
  const fetched = await fetchOrigin(git, linked.path);
  if (fetched.code !== 0) {
    warnings.push(
      `${repository}: fetching origin failed, using local refs: ${fetched.stderr.trim()}`,
    );
  }
  // Every probe runs through the same runner; it already adds the promptless environment.
  const checkout = deliveryCheckout(linked.path, (args, { input, timeoutMs }) =>
    git(linked.path, [...args], {
      env: { GIT_NO_LAZY_FETCH: "1" },
      ...(input !== undefined ? { input } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }),
  );
  const resolution = await resolveDeliveryBranch(
    checkout,
    { companionPath, repository, worksetId },
    ticket ? { ticket } : {},
  );
  // Concerns the companion, not a repository: reported once, first.
  const { templateDiagnostic } = resolution;
  if (templateDiagnostic && !warnings.includes(templateDiagnostic)) {
    warnings.unshift(templateDiagnostic);
  }
  const { branch, source } = resolution;
  if (branch === null || source === null) {
    return resolution.diagnostics.map((line) => `${repository}: ${line}`);
  }
  // A resolved branch's diagnostics only inform, e.g. a ticket that names nothing.
  warnings.push(...resolution.diagnostics.map((line) => `${repository}: ${line}`));
  const entries = await listWorktrees(git, linked.path);
  const main = entries?.[0];
  if (!main) return [`${repository}: cannot list the worktrees of ${linked.path}`];
  const target = await canonical(
    linked.umbrella
      ? path.join(worktreePathFor(linked.umbrella, worksetId), path.basename(linked.path))
      : worktreePathFor(main.path, worksetId),
  );
  const atTarget = entries.find((entry) => entry.path === target);
  // A stale entry is never reused: wrapping it would only refill a folder without a checkout.
  const stale = entries.find(
    (entry) => entry.stale && (entry.path === target || entry.branch === branch),
  );
  if (stale) {
    return [
      `${repository}: ${stale.path} is a stale worktree entry (${stale.stale}); remove any folder left there, run \`git worktree prune\` in ${main.path}, then retry`,
    ];
  }
  const plan = {
    repository,
    repositoryId: linked.id,
    checkout: main.path,
    branch,
    source,
    ...(linked.umbrella ? { umbrella: linked.umbrella } : {}),
  };
  const elsewhere = entries.find((entry) => entry.branch === branch && entry.path !== target);
  const inherited = resolution.inheritedFrom.join(", ");
  const take = Boolean(takeBranch && elsewhere?.path === main.path);
  // An inherited branch is the dependency's worktree; one branch has one worktree.
  // In the main checkout, only `--take-branch` moves it out.
  if (elsewhere && inherited && !atTarget && !take) {
    if (elsewhere.path === main.path) {
      return [
        `${repository}: ${branch}, inherited from ${inherited}, is checked out in ${main.path}; work there or switch it to another branch`,
      ];
    }
    warnings.push(
      `${repository}: ${branch} is inherited from ${inherited}; reusing its worktree at ${elsewhere.path}`,
    );
    return { ...plan, target: elsewhere.path, reuse: true };
  }
  const reuse = atTarget?.branch === branch;
  if (!reuse && (atTarget || (await exists(target)))) {
    return [`${repository}: ${target} exists and is not a worktree of ${repository} on ${branch}`];
  }
  if (take) {
    const refusal = await takeRefusal(git, main.path, branch, checkout, protectedPatterns ?? []);
    if (refusal) return [`${repository}: ${refusal}`];
    return { ...plan, target, reuse: false, take: true };
  }
  if (elsewhere) return [`${repository}: ${branch} is already checked out at ${elsewhere.path}`];
  return {
    ...plan,
    target,
    base: source === "new" ? await newBranchBase(checkout.hasRef) : undefined,
    reuse,
  };
}

/** Why `--take-branch` leaves `branch` in the main checkout `main`, or null to take it. */
async function takeRefusal(
  git: GitRunner,
  main: string,
  branch: string,
  checkout: { defaultBranch(): Promise<string> },
  patterns: ProtectedPatterns,
): Promise<string | null> {
  const protection = classifyBranch(branch, {
    defaultBranch: await checkout.defaultBranch(),
    patterns,
  });
  if (protection.protected) {
    return `--take-branch does not take the protected branch ${branch} out of ${main}`;
  }
  return trackedChangesRefusal(git, main);
}

/** Why `main`'s tracked changes block a take, or null when it has none. */
async function trackedChangesRefusal(git: GitRunner, main: string): Promise<string | null> {
  const status = await git(main, ["status", "--porcelain", "-z", "--untracked-files=no"]);
  if (status.code !== 0) return `cannot read the status of ${main}: ${status.stderr.trim()}`;
  // `XY path\0`; a rename or copy, in either column, adds its source as the next field,
  // which is skipped.
  const fields = status.stdout.split("\0");
  const changed: string[] = [];
  for (let at = 0; at < fields.length; at++) {
    const field = fields[at]!;
    if (field.length <= 3) continue;
    changed.push(field.slice(3));
    if (/[RC]/.test(field.slice(0, 2))) at++;
  }
  if (changed.length > 0) {
    return `${main} has uncommitted changes to tracked files (${changed.join(", ")}); commit or stash them, then retry --take-branch`;
  }
  return null;
}

async function addWorktree(git: GitRunner, plan: Plan): Promise<string | null> {
  const result = await git(plan.checkout, worktreeAddArgs(plan, plan.target, plan.base));
  return result.code === 0 ? null : `creating the worktree failed: ${result.stderr.trim()}`;
}

/**
 * `--take-branch`: detach the main checkout, add the worktree, and undo both on failure.
 * Earlier repositories' takes stay: their worktrees are made, as for any later failure.
 */
async function takeIntoWorktree(
  git: GitRunner,
  plan: Plan,
  warnings: string[],
): Promise<string | null> {
  // Checked again: earlier repositories' setup may have given the developer time to edit.
  const changed = await trackedChangesRefusal(git, plan.checkout);
  if (changed) return changed;
  const detached = await git(plan.checkout, ["switch", "--detach"]);
  if (detached.code !== 0) return `detaching ${plan.checkout} failed: ${detached.stderr.trim()}`;
  const failure = await addWorktree(git, plan);
  if (!failure) {
    warnings.push(
      `${plan.repository}: ${plan.checkout} is now on a detached HEAD; ${plan.branch} moved to ${plan.target}`,
    );
    return null;
  }
  // Back to the state before the command, so a failed take changes nothing visible. A
  // worktree registered before the add failed still holds the branch; the planned target
  // did not exist, so removing it drops only what the add left. A failed remove matters
  // only when the switch back fails too: an add that registered nothing leaves nothing.
  const removed = await git(plan.checkout, ["worktree", "remove", "--force", plan.target]);
  await git(plan.checkout, ["worktree", "prune"]);
  const restored = await git(plan.checkout, ["switch", plan.branch]);
  if (restored.code === 0) return failure;
  const kept =
    removed.code === 0 ? "" : `; removing ${plan.target} failed: ${removed.stderr.trim()}`;
  return `${failure}${kept}; switching ${plan.checkout} back to ${plan.branch} failed: ${restored.stderr.trim()}`;
}

/** The runtimes `checkout` is wrapped for, in wrap order. */
async function wrappedRuntimes(checkout: string, deps: WorktreeDeps): Promise<WrapRuntime[]> {
  const state = await (deps.readWrapState ?? readWrapState)(checkout);
  return WRAP_RUNTIMES.filter((runtime) => state.runtimes.has(runtime));
}

/** Wraps the worktree for exactly the runtimes its main checkout is wrapped for. */
async function wrapWorktree(
  companionPath: string,
  checkout: string,
  repository: LinkedRepository,
  deps: WorktreeDeps,
): Promise<WrapOutcome> {
  let runtimes: WrapRuntime[];
  try {
    runtimes = await wrappedRuntimes(checkout, deps);
  } catch (error) {
    return {
      runtimes: [],
      outcome: "failed",
      reason: `cannot read the wrap of ${checkout}: ${errorMessage(error)}`,
    };
  }
  if (runtimes.length === 0) {
    return { runtimes, outcome: "skipped", reason: "main checkout not wrapped" };
  }
  let failure: string | null;
  try {
    failure = await (deps.wrap ?? runWrap)(companionPath, repository, runtimes);
  } catch (error) {
    failure = errorMessage(error);
  }
  return failure ? { runtimes, outcome: "failed", reason: failure } : { runtimes, outcome: "ok" };
}

async function installCommand(worktree: string): Promise<string[] | null> {
  for (const [lockfile, command] of LOCKFILES) {
    // oxlint-disable-next-line no-await-in-loop -- lockfile order decides
    if (await exists(path.join(worktree, lockfile))) return command;
  }
  return null;
}

/** Ignored, untracked env files of the main checkout absent from the worktree; paths only. */
async function missingEnvFiles(
  git: GitRunner,
  checkout: string,
  worktree: string,
): Promise<string[]> {
  const listed = await git(checkout, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  if (listed.code !== 0) return [];
  const candidates = listed.stdout
    .split("\0")
    .filter(
      (entry) =>
        entry &&
        !entry.endsWith("/") &&
        !entry.split("/").includes("node_modules") &&
        ENV_NAME.test(path.posix.basename(entry)) &&
        !ENV_EXAMPLE.test(entry),
    );
  const missing = await Promise.all(
    candidates.map(async (entry) => ((await exists(path.join(worktree, entry))) ? null : entry)),
  );
  return missing.filter((entry): entry is string => entry !== null).toSorted();
}

export interface CreateWorktreesOptions {
  install: boolean;
  /**
   * Names a new Delivery Branch by the template (default `workset/<TICKET>-<id>`); an existing
   * or recorded one wins.
   */
  ticket?: string;
  /** Pass the installer's output through; false discards it, as `--json` needs. */
  streamInstall: boolean;
  /**
   * Take a resolved, unprotected branch, inherited ones included, out of a main checkout
   * without tracked changes: detach that checkout, then add the worktree on the branch.
   */
  takeBranch?: boolean;
}

/**
 * Creates or reuses the Workset's worktree in each of its Working Repositories. Checks
 * everything first and creates nothing when a check fails; a later failure is reported
 * for its repository and keeps the worktrees already made.
 */
export async function createWorksetWorktrees(
  companionPath: string,
  worksetId: string,
  options: CreateWorktreesOptions,
  deps: WorktreeDeps = {},
): Promise<WorktreeResult> {
  const target = await recordTarget(companionPath, worksetId);
  return createTargetWorktrees(companionPath, worksetId, target, options, deps);
}

/**
 * As `createWorksetWorktrees`, for the Workset the change resolves to, implicit ones
 * included; writes no Workset record.
 */
export async function createChangeWorktrees(
  companionPath: string,
  change: string,
  options: CreateWorktreesOptions,
  deps: WorktreeDeps = {},
): Promise<WorktreeResult> {
  const target = await changeTarget(companionPath, change);
  return createTargetWorktrees(companionPath, change, target, options, deps);
}

/** `fallbackId` names the result when the target did not resolve. */
async function createTargetWorktrees(
  companionPath: string,
  fallbackId: string,
  target: Target | string[],
  options: CreateWorktreesOptions,
  deps: WorktreeDeps,
): Promise<WorktreeResult> {
  if (Array.isArray(target)) {
    return { workset: fallbackId, ok: false, repositories: [], diagnostics: target, warnings: [] };
  }
  const worksetId = target.id;
  const git = deps.git ?? runGit;
  const cwd = (deps.cwd ?? process.cwd)();
  const { plans, mirror, diagnostics, warnings } = await planWorktrees(
    companionPath,
    target,
    git,
    cwd,
    options,
  );
  if (diagnostics.length > 0) {
    return { workset: worksetId, ok: false, repositories: [], diagnostics, warnings };
  }
  const repositories: WorktreeRepositoryResult[] = [];
  const indexing: Promise<void>[] = [];
  const progress = options.streamInstall
    ? (line: string) => process.stderr.write(`${line}\n`)
    : undefined;
  for (const plan of plans) {
    // oxlint-disable-next-line no-await-in-loop -- one repository at a time, installs included
    const result = await realize(companionPath, plan, options, git, deps, warnings);
    repositories.push(result);
    if (result.index.reason === NOT_CREATED) continue;
    // Indexing overlaps the next repository's setup; only the report waits for it.
    indexing.push(
      indexWorktree(plan.checkout, plan.target, companionPath, deps.tokensave, (action) =>
        progress?.(`${plan.repository}: tokensave ${action} of ${plan.target}…`),
      ).then((index) => {
        result.index = index;
      }),
    );
  }
  // After its children exist, so the folder is linked only once it holds a worktree.
  const held = plans.flatMap((plan, at) =>
    plan.umbrella && repositories[at]!.install.reason !== NOT_CREATED ? [plan.repository] : [],
  );
  const umbrella =
    mirror && held.length > 0
      ? await realizeMirror(companionPath, mirror, held, deps, warnings)
      : undefined;
  // An unlinked mirror is reported broken; it gets no index. It holds the children's
  // worktrees, so it is indexed after theirs rather than over them.
  if (umbrella && mirror && !umbrella.error) {
    const children = Promise.all(indexing);
    indexing.push(
      children
        .then(() =>
          indexWorktree(
            mirror.umbrella,
            mirror.folder,
            companionPath,
            deps.tokensave,
            (action) => progress?.(`${mirror.umbrella}: tokensave ${action} of ${mirror.folder}…`),
            UMBRELLA_NOT_INDEXED,
          ),
        )
        .then((index) => {
          umbrella.index = index;
        }),
    );
  }
  await Promise.all(indexing);
  for (const result of repositories) {
    if (result.index.outcome === "failed") {
      warnings.push(`${result.repository}: tokensave index step failed: ${result.index.reason}`);
    }
  }
  if (umbrella?.index.outcome === "failed") {
    warnings.push(`${umbrella.path}: tokensave index step failed: ${umbrella.index.reason}`);
  }
  return {
    workset: worksetId,
    ok: repositories.every((entry) => !entry.error) && !umbrella?.error,
    repositories,
    ...(umbrella ? { umbrella } : {}),
    diagnostics,
    warnings,
  };
}

/**
 * Links the mirrored worktree folder under the umbrella's id, without the companion
 * registry, and wraps it for the umbrella's runtimes. Its children get neither: the
 * folder's projection serves them, as the umbrella's serves its own.
 */
async function realizeMirror(
  companionPath: string,
  mirror: Mirror,
  repositories: string[],
  deps: WorktreeDeps,
  warnings: string[],
): Promise<UmbrellaWorktreeResult> {
  const { wrap, error, warning } = await linkAndWrap(
    companionPath,
    { id: mirror.repositoryId, path: mirror.folder },
    mirror.umbrella,
    mirror.reuse,
    deps,
  );
  if (warning) warnings.push(`${mirror.folder}: ${warning}`);
  return {
    path: mirror.umbrella,
    worktree: mirror.folder,
    action: mirror.reuse ? "reused" : "created",
    repositories,
    wrap,
    index: { outcome: "skipped", ...(error ? { reason: "mirrored worktree broken" } : {}) },
    ...(error ? { error } : {}),
  };
}

/**
 * Links `repository.path` to the companion and wraps it like `wrappedFrom`. A reused
 * folder still wrapped from before stays usable, so a failed refresh only warns.
 */
async function linkAndWrap(
  companionPath: string,
  repository: LinkedRepository,
  wrappedFrom: string,
  reuse: boolean,
  deps: WorktreeDeps,
): Promise<{ wrap: WrapOutcome; error?: string; warning?: string }> {
  try {
    await (deps.writeLink ?? writeRepoLocalRegistryEntry)(
      repository.path,
      companionPath,
      repository,
      "existing",
    );
  } catch (error) {
    return {
      wrap: { runtimes: [], outcome: "skipped", reason: "worktree not linked" },
      error: `linking the worktree failed: ${errorMessage(error)}`,
    };
  }
  const wrap = await wrapWorktree(companionPath, wrappedFrom, repository, deps);
  if (wrap.outcome !== "failed") return { wrap };
  const message = `wrapping the worktree failed: ${wrap.reason}`;
  if (reuse && (await stillWrapped(repository.path, wrap.runtimes, deps))) {
    return { wrap, warning: `${message}; its earlier wrap stays` };
  }
  return { wrap, error: message };
}

async function realize(
  companionPath: string,
  plan: Plan,
  options: CreateWorktreesOptions,
  git: GitRunner,
  deps: WorktreeDeps,
  warnings: string[],
): Promise<WorktreeRepositoryResult> {
  const result: WorktreeRepositoryResult = {
    repository: plan.repository,
    checkout: plan.checkout,
    path: plan.target,
    branch: plan.branch,
    action: plan.reuse ? "reused" : "created",
    install: { command: null, outcome: "skipped" },
    wrap: { runtimes: [], outcome: "skipped" },
    index: { outcome: "skipped" },
    missingEnv: [],
  };
  if (!plan.reuse) {
    const failure = plan.take
      ? await takeIntoWorktree(git, plan, warnings)
      : await addWorktree(git, plan);
    if (failure) {
      return {
        ...result,
        install: { ...result.install, reason: NOT_CREATED },
        wrap: { ...result.wrap, reason: NOT_CREATED },
        index: { outcome: "skipped", reason: NOT_CREATED },
        error: failure,
      };
    }
  }
  if (plan.umbrella) {
    result.wrap.reason = "served by the mirrored worktree";
  } else {
    // The main checkout's id: a session moved here keeps its `MATE_REPOSITORY_ID`.
    const linked = await linkAndWrap(
      companionPath,
      { id: plan.repositoryId, path: plan.target },
      plan.checkout,
      plan.reuse,
      deps,
    );
    result.wrap = linked.wrap;
    if (linked.error) result.error = linked.error;
    if (linked.warning) warnings.push(`${plan.repository}: ${linked.warning}`);
  }
  const command = await installCommand(plan.target);
  result.install.command = command ? command.join(" ") : null;
  if (plan.reuse) result.install.reason = "reused worktree";
  else if (!options.install) result.install.reason = "--no-install";
  else if (!command) result.install.reason = "no lockfile";
  else {
    const ok = await (deps.install ?? runInstall)(plan.target, command, options.streamInstall);
    result.install.outcome = ok ? "ok" : "failed";
    if (!ok) result.error ??= `${command.join(" ")} failed`;
  }
  // The caller indexes after install, regardless of `--no-install`: the index is not a dependency install.
  result.missingEnv = await missingEnvFiles(git, plan.checkout, plan.target);
  return result;
}

async function stillWrapped(
  worktree: string,
  runtimes: readonly WrapRuntime[],
  deps: WorktreeDeps,
): Promise<boolean> {
  try {
    const own = await wrappedRuntimes(worktree, deps);
    return runtimes.every((runtime) => own.includes(runtime));
  } catch {
    return false;
  }
}

/** Whether `cwd` is the worktree or lies inside it. */
async function holds(worktree: string, cwd: string): Promise<boolean> {
  const relative = path.relative(worktree, await canonical(cwd));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Why a worktree must stay, or null when it is clean and every commit is on a remote. */
async function keepReason(
  git: GitRunner,
  listed: WorktreeEntry,
  cwd: string,
): Promise<string | null> {
  if (listed.locked) return "locked";
  if (listed.stale) return `stale worktree entry (${listed.stale}); run \`git worktree prune\``;
  const worktree = listed.path;
  if (await holds(worktree, cwd)) return "in use (current directory)";
  const status = await git(worktree, ["status", "--porcelain"]);
  if (status.code !== 0) return `cannot read its status: ${status.stderr.trim()}`;
  if (status.stdout.trim()) return "uncommitted changes or untracked files";
  const unpushed = await git(worktree, ["log", "--oneline", "HEAD", "--not", "--remotes"]);
  if (unpushed.code !== 0) return `cannot read its commits: ${unpushed.stderr.trim()}`;
  if (unpushed.stdout.trim()) return "commits on no remote";
  return null;
}

/** Recorded Delivery Branches per Working Repository; not-applicable deliveries name none. */
async function recordedBranches(
  companionPath: string,
  changes: readonly string[],
  warnings: string[],
): Promise<Map<string, Set<string>>> {
  const byRepository = new Map<string, Set<string>>();
  for (const change of changes) {
    // oxlint-disable-next-line no-await-in-loop -- a few small files, in order
    const location = await locateChange(companionPath, change);
    if (!location) continue;
    let record: DeliveryRecord | null;
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few small files, in order
      record = await readDeliveryRecord(location.dir);
    } catch (error) {
      warnings.push(`${change}: cannot read its Delivery Record: ${errorMessage(error)}`);
      continue;
    }
    for (const delivery of record?.deliveries ?? []) {
      if (!delivery.branch || delivery.notApplicable) continue;
      const branches = byRepository.get(delivery.repository) ?? new Set<string>();
      branches.add(delivery.branch);
      byRepository.set(delivery.repository, branches);
    }
  }
  return byRepository;
}

/** Returns the Umbrella Repository whose child the repository is, so its mirror is pruned after. */
async function pruneRepository(
  companionPath: string,
  worksetId: string,
  repository: string,
  branches: ReadonlySet<string>,
  index: LinkedIndex,
  git: GitRunner,
  deps: WorktreeDeps,
  result: PruneResult,
): Promise<LinkedCheckout | undefined> {
  const { linked } = linkedCheckout(index, repository);
  if (!linked) return undefined;
  const entries = await listWorktrees(git, linked.path);
  const main = entries?.[0];
  if (!main) {
    result.warnings.push(`${repository}: cannot list the worktrees of ${linked.path}`);
    return linked.umbrella ? linked : undefined;
  }
  // The first entry is the main checkout; a detached HEAD has no branch and never matches.
  const candidates = entries
    .slice(1)
    .filter((entry) => entry.branch !== null && branches.has(entry.branch));
  for (const listed of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- Git operations on one checkout, one at a time
    await pruneWorktree(
      companionPath,
      { worksetId, repository, main: main.path, linked, listed },
      git,
      deps,
      result,
    );
  }
  return linked.umbrella ? linked : undefined;
}

interface PruneCandidate {
  worksetId: string;
  repository: string;
  /** The main checkout's path. */
  main: string;
  linked: LinkedCheckout;
  listed: WorktreeEntry;
}

async function pruneWorktree(
  companionPath: string,
  candidate: PruneCandidate,
  git: GitRunner,
  deps: WorktreeDeps,
  result: PruneResult,
): Promise<void> {
  const { worksetId, repository, main, linked, listed } = candidate;
  const target = listed.path;
  const entry = { workset: worksetId, repository, path: target };
  const cwd = (deps.cwd ?? process.cwd)();
  const reason = await keepReason(git, listed, cwd);
  if (reason) {
    result.kept.push({ ...entry, reason });
    return;
  }
  // A worktree in the mirrored folder carries no wrap; the folder is unwrapped after.
  const inMirror =
    linked.umbrella !== undefined &&
    path.dirname(target) === (await canonical(worktreePathFor(linked.umbrella, worksetId)));
  if (!inMirror) {
    // Unwrap first: machine-local state keyed by its path (Claude local-scope MCP) must not outlive it.
    try {
      await (deps.unwrap ?? cleanupWorkingRepository)(target, [companionPath]);
    } catch (error) {
      result.kept.push({ ...entry, reason: `removing its wrap failed: ${errorMessage(error)}` });
      return;
    }
  }
  const removed = await git(main, ["worktree", "remove", target]);
  if (removed.code === 0) {
    result.removed.push(entry);
    return;
  }
  const refused = removed.stderr.trim() || "git refused";
  if (inMirror) {
    result.kept.push({ ...entry, reason: refused });
    return;
  }
  // The umbrella's id is no link for a child's own worktree, so Mate cannot re-wrap it.
  if (linked.umbrella) {
    result.kept.push({
      ...entry,
      reason: `${refused}; its wrap was removed, run \`${FRAMEWORK_NAME} wrap\` there`,
    });
    return;
  }
  // Kept, so it gets its guardrails back.
  const rewrap = await wrapWorktree(companionPath, main, { id: linked.id, path: target }, deps);
  result.kept.push({
    ...entry,
    reason:
      rewrap.outcome === "failed"
        ? `${refused}; re-wrapping it failed, run \`${FRAMEWORK_NAME} wrap\` there: ${rewrap.reason}`
        : refused,
  });
}

/**
 * Removes the worktrees of the given (Done) Worksets that are clean and fully pushed,
 * without `--force`, and never deletes a branch. A worktree belongs to a Workset when it is
 * a linked worktree with a Delivery Branch of the Workset's changes checked out, wherever
 * it lives. The main checkout and a worktree holding the working directory stay, as does
 * every other worktree. Each is unwrapped before removal.
 */
export async function pruneWorksetWorktrees(
  companionPath: string,
  done: readonly PruneTarget[],
  deps: WorktreeDeps = {},
): Promise<PruneResult> {
  const git = deps.git ?? runGit;
  const result: PruneResult = { removed: [], kept: [], warnings: [] };
  let index: LinkedIndex | undefined;
  for (const workset of done) {
    // oxlint-disable-next-line no-await-in-loop -- Worksets one at a time
    const branches = await recordedBranches(companionPath, workset.changes, result.warnings);
    if (branches.size === 0) continue;
    // oxlint-disable-next-line no-await-in-loop -- read once, on first need
    index ??= await linkedIndex(companionPath, git, (deps.cwd ?? process.cwd)());
    // Umbrella path to its Repository Link id.
    const umbrellas = new Map<string, string>();
    for (const [repository, names] of branches) {
      // oxlint-disable-next-line no-await-in-loop -- Git operations on shared checkouts, one at a time
      const child = await pruneRepository(
        companionPath,
        workset.id,
        repository,
        names,
        index,
        git,
        deps,
        result,
      );
      if (child?.umbrella) umbrellas.set(child.umbrella, child.id);
    }
    for (const [umbrella, repositoryId] of umbrellas) {
      // oxlint-disable-next-line no-await-in-loop -- after its children, one at a time
      await pruneMirror(
        companionPath,
        { worksetId: workset.id, umbrella, repositoryId },
        deps,
        result,
      );
    }
  }
  return result;
}

/** Files the OS writes into any folder it shows, e.g. Finder's; never anyone's work. */
const OS_METADATA = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * Top-level names a wrap, a link, or the OS may write; everything else in a mirrored
 * worktree is someone's work.
 */
function mirrorMaterial(): Set<string> {
  return new Set([
    ...projectionEntries()
      .map((entry) => entry.path.split(/[\\/]/)[0]!)
      .filter((name) => name !== ".git" && name !== "~"),
    ...OS_METADATA,
  ]);
}

/**
 * Best effort: unwraps and removes the Workset's mirrored worktree, then an empty
 * `<umbrella>.worktrees`, only when nothing but Mate's material is left. Never recursive,
 * never forced; a folder that stays is named with the reason.
 */
async function pruneMirror(
  companionPath: string,
  mirror: { worksetId: string; umbrella: string; repositoryId: string },
  deps: WorktreeDeps,
  result: PruneResult,
): Promise<void> {
  const { worksetId, umbrella, repositoryId } = mirror;
  const folder = await canonical(worktreePathFor(umbrella, worksetId));
  // Only this companion's mirrored worktree, never a folder it does not own.
  if (!(await isMirrorOf(folder, companionPath, repositoryId))) return;
  const umbrellas = (result.umbrellas ??= { removed: [], kept: [] });
  const entry = { workset: worksetId, umbrella, path: folder };
  const keep = (reason: string): void => void umbrellas.kept.push({ ...entry, reason });
  if (await holds(folder, (deps.cwd ?? process.cwd)())) return keep("in use (current directory)");
  const material = mirrorMaterial();
  const listed = await fs.readdir(folder).catch(() => null);
  if (listed === null) return keep("cannot list its entries");
  const others = listed.filter((name) => !material.has(name)).toSorted();
  if (others.length > 0) return keep(`still holds ${others.join(", ")}`);
  try {
    await (deps.unwrap ?? cleanupWorkingRepository)(folder, [companionPath]);
  } catch (error) {
    return keep(`removing its wrap failed: ${errorMessage(error)}`);
  }
  // A failure shows below as what unwrapping left.
  await Promise.all(
    listed
      .filter((name) => OS_METADATA.has(name))
      .map((name) => fs.rm(path.join(folder, name), { force: true }).catch(() => undefined)),
  );
  try {
    await fs.rmdir(folder);
  } catch (error) {
    const left = await fs.readdir(folder).catch(() => []);
    const refused =
      left.length > 0
        ? `unwrapping left ${left.toSorted().join(", ")}`
        : `removing it failed: ${errorMessage(error)}`;
    // Kept, so it gets its link and guardrails back, and a later prune finds it again.
    const restored = await linkAndWrap(
      companionPath,
      { id: repositoryId, path: folder },
      umbrella,
      false,
      deps,
    );
    const failure = restored.error ?? restored.warning;
    return keep(
      failure
        ? `${refused}; restoring it failed, run \`${FRAMEWORK_NAME} wrap\` there: ${failure}`
        : refused,
    );
  }
  umbrellas.removed.push(entry);
  // The parent stays while another Workset's mirror is in it.
  await fs.rmdir(path.dirname(folder)).catch(() => undefined);
}
