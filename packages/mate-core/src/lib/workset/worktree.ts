import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { gitEnvironment, withoutAskPass } from "../../runtime/companion-git";
import { withCompanionLock } from "../../runtime/companion-lock";
import { errorMessage } from "../../runtime/error-message";
import type { WrapRuntime } from "../../runtime/runtime-document-manifest";
import { readWrapState, WRAP_RUNTIMES } from "../../runtime/wrap-state";
import { cleanupWorkingRepository } from "../../tools/setup/working-repo-cleanup";
import { locateChange } from "../change-layout";
import { workingRepoGit } from "../delivery/branches";
import { mergeGit } from "../delivery/merge-git";
import { type DeliveryRecord, readDeliveryRecord } from "../delivery/record";
import {
  listRefsWith,
  mergeProbeWith,
  newBranchBase,
  resolveDeliveryBranch,
  worktreeAddArgs,
  type BranchSource,
} from "../delivery/resolve-branch";
import { scopedRepositories } from "../openspec-scopes";
import { attendedLockOptions } from "../orchestrator/companion-git-sync";
import {
  findRepoLocalLinkTo,
  readCompanionRegistry,
  writeRepoLocalRegistryEntry,
} from "../orchestrator/repository-link";
import type { LinkedRepository } from "../orchestrator/types";
import { runWrapPass } from "../orchestrator/wrap-pass";
import { identityOf } from "./repositories";
import { indexWorktree, type IndexOutcome, type TokensaveRunner } from "./worktree-index";
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

export interface WorktreeResult {
  workset: string;
  ok: boolean;
  repositories: WorktreeRepositoryResult[];
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

export interface PruneResult {
  removed: PruneEntry[];
  kept: (PruneEntry & { reason: string })[];
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
    const child = execFile(
      "git",
      args,
      { cwd, env: { ...promptlessEnv(), ...options.env }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
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

interface LinkedLookup {
  linked: LinkedRepository | null;
  /** Registered paths that no longer exist. */
  missing: string[];
}

/**
 * The first checkout linked to the companion whose `origin` is the repository: an
 * existing registered one, else the checkout holding `cwd` when its repo-local link
 * names the companion, so an entry left naming a removed folder does not hide it.
 */
async function linkedCheckout(
  companionPath: string,
  repository: string,
  git: GitRunner,
  cwd: string,
): Promise<LinkedLookup> {
  let repos: LinkedRepository[] = [];
  try {
    repos = (await readCompanionRegistry(companionPath)).repos;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const present = await Promise.all(repos.map((repo) => exists(repo.path)));
  const current = await findRepoLocalLinkTo(cwd, companionPath);
  const candidates = [...repos.filter((_, index) => present[index]), ...(current ? [current] : [])];
  const identities = await Promise.all(
    candidates.map(async (repo) => {
      // Raw config, not `remote get-url`, so `insteadOf` rewrites do not change the identity.
      const remote = await git(repo.path, ["config", "--get", "remote.origin.url"]);
      return remote.code === 0 ? identityOf(remote.stdout.trim()) : null;
    }),
  );
  // The first match in registry order decides.
  const index = identities.findIndex(
    (identity) => identity?.toLowerCase() === repository.toLowerCase(),
  );
  return {
    linked: index === -1 ? null : candidates[index]!,
    missing: repos.filter((_, at) => !present[at]).map((repo) => repo.path),
  };
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

/** Phase 1: every check for every repository; any failure means nothing is created. */
async function planWorktrees(
  companionPath: string,
  target: Target,
  git: GitRunner,
  cwd: string,
  ticket?: string,
): Promise<{ plans: Plan[]; diagnostics: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const checked = await Promise.all(
    target.repositories.map((repository) =>
      planRepository(companionPath, target.id, repository, git, cwd, warnings, ticket),
    ),
  );
  return {
    plans: checked.filter((entry): entry is Plan => !Array.isArray(entry)),
    diagnostics: checked.flatMap((entry) => (Array.isArray(entry) ? entry : [])),
    warnings,
  };
}

/** One repository's plan, or the diagnostics that stop the run. */
async function planRepository(
  companionPath: string,
  worksetId: string,
  repository: string,
  git: GitRunner,
  cwd: string,
  warnings: string[],
  ticket?: string,
): Promise<Plan | string[]> {
  const { linked, missing } = await linkedCheckout(companionPath, repository, git, cwd);
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
  const hasRef = async (ref: string) =>
    (await git(linked.path, ["rev-parse", "--verify", "--quiet", ref])).code === 0;
  const resolution = await resolveDeliveryBranch({
    companionPath,
    repository,
    hasRef,
    listRefs: listRefsWith(async (args) => {
      const listed = await git(linked.path, args);
      return listed.code === 0 ? listed.stdout : null;
    }),
    mergeProbe: mergeProbeWith(
      mergeGit(linked.path),
      await workingRepoGit(linked.path).defaultBranch(),
    ),
    worksetId,
    ...(ticket ? { ticket } : {}),
  });
  const { branch, source } = resolution;
  if (branch === null || source === null) {
    return resolution.diagnostics.map((line) => `${repository}: ${line}`);
  }
  // A resolved branch's diagnostics only inform, e.g. a ticket that names nothing.
  warnings.push(...resolution.diagnostics.map((line) => `${repository}: ${line}`));
  const entries = await listWorktrees(git, linked.path);
  const main = entries?.[0];
  if (!main) return [`${repository}: cannot list the worktrees of ${linked.path}`];
  const target = await canonical(worktreePathFor(main.path, worksetId));
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
  const plan = { repository, repositoryId: linked.id, checkout: main.path, branch, source };
  const elsewhere = entries.find((entry) => entry.branch === branch && entry.path !== target);
  const inherited = resolution.inheritedFrom.join(", ");
  // An inherited branch is the dependency's worktree; one branch has one worktree.
  if (elsewhere && inherited && !atTarget) {
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
  if (elsewhere) return [`${repository}: ${branch} is already checked out at ${elsewhere.path}`];
  return {
    ...plan,
    target,
    base: source === "new" ? await newBranchBase(hasRef) : undefined,
    reuse,
  };
}

async function addWorktree(git: GitRunner, plan: Plan): Promise<string | null> {
  const result = await git(plan.checkout, worktreeAddArgs(plan, plan.target, plan.base));
  return result.code === 0 ? null : `creating the worktree failed: ${result.stderr.trim()}`;
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
  /** Names a new Delivery Branch `workset/<TICKET>-<id>`; an existing or recorded one wins. */
  ticket?: string;
  /** Pass the installer's output through; false discards it, as `--json` needs. */
  streamInstall: boolean;
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
  const { plans, diagnostics, warnings } = await planWorktrees(
    companionPath,
    target,
    git,
    cwd,
    options.ticket,
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
  await Promise.all(indexing);
  for (const result of repositories) {
    if (result.index.outcome === "failed") {
      warnings.push(`${result.repository}: tokensave index step failed: ${result.index.reason}`);
    }
  }
  return {
    workset: worksetId,
    ok: repositories.every((entry) => !entry.error),
    repositories,
    diagnostics,
    warnings,
  };
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
    const failure = await addWorktree(git, plan);
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
  // The main checkout's id: a session moved here keeps its `MATE_REPOSITORY_ID`.
  const repository = { id: plan.repositoryId, path: plan.target };
  try {
    await (deps.writeLink ?? writeRepoLocalRegistryEntry)(
      plan.target,
      companionPath,
      repository,
      "existing",
    );
    result.wrap = await wrapWorktree(companionPath, plan.checkout, repository, deps);
    if (result.wrap.outcome === "failed") {
      const message = `wrapping the worktree failed: ${result.wrap.reason}`;
      // A reused worktree still wrapped from before stays usable; only refreshing it failed.
      if (plan.reuse && (await stillWrapped(plan.target, result.wrap.runtimes, deps))) {
        warnings.push(`${plan.repository}: ${message}; its earlier wrap stays`);
      } else {
        result.error = message;
      }
    }
  } catch (error) {
    result.error = `linking the worktree failed: ${errorMessage(error)}`;
    result.wrap.reason = "worktree not linked";
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

async function pruneRepository(
  companionPath: string,
  worksetId: string,
  repository: string,
  branches: ReadonlySet<string>,
  git: GitRunner,
  deps: WorktreeDeps,
  result: PruneResult,
): Promise<void> {
  const { linked } = await linkedCheckout(
    companionPath,
    repository,
    git,
    (deps.cwd ?? process.cwd)(),
  );
  if (!linked) return;
  const entries = await listWorktrees(git, linked.path);
  const main = entries?.[0];
  if (!main) {
    result.warnings.push(`${repository}: cannot list the worktrees of ${linked.path}`);
    return;
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
}

interface PruneCandidate {
  worksetId: string;
  repository: string;
  /** The main checkout's path. */
  main: string;
  linked: LinkedRepository;
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
  // Unwrap first: machine-local state keyed by its path (Claude local-scope MCP) must not outlive it.
  try {
    await (deps.unwrap ?? cleanupWorkingRepository)(target, [companionPath]);
  } catch (error) {
    result.kept.push({ ...entry, reason: `removing its wrap failed: ${errorMessage(error)}` });
    return;
  }
  const removed = await git(main, ["worktree", "remove", target]);
  if (removed.code === 0) {
    result.removed.push(entry);
    return;
  }
  const refused = removed.stderr.trim() || "git refused";
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
  for (const workset of done) {
    // oxlint-disable-next-line no-await-in-loop -- Worksets one at a time
    const branches = await recordedBranches(companionPath, workset.changes, result.warnings);
    for (const [repository, names] of branches) {
      // oxlint-disable-next-line no-await-in-loop -- Git operations on shared checkouts, one at a time
      await pruneRepository(companionPath, workset.id, repository, names, git, deps, result);
    }
  }
  return result;
}
