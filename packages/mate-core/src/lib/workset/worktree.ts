import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { gitEnvironment } from "../../runtime/companion-git";
import { errorMessage } from "../../runtime/error-message";
import { locateChange } from "../change-layout";
import { defaultDeliveryBranch } from "../delivery/record";
import { scopedRepositories } from "../openspec-scopes";
import {
  readCompanionRegistry,
  writeRepoLocalRegistryEntry,
} from "../orchestrator/repository-link";
import { identityOf } from "./repositories";
import {
  findWorkset,
  readWorksets,
  resolveWorksetBranch,
  resolveWorksetOf,
  type WorksetRecord,
} from "./record";

/**
 * Workset worktrees outside the factory: one Git worktree per Working Repository at
 * `<main checkout>.worktrees/<workset-id>`, on the Workset's Delivery Branch, linked to
 * the companion and installed. Env files are reported by path, never opened.
 */

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (cwd: string, args: string[]) => Promise<GitResult>;

/** Runs an install command; `stream` passes its output through, otherwise it is discarded. */
export type InstallRunner = (cwd: string, command: string[], stream: boolean) => Promise<boolean>;

export interface WorktreeDeps {
  git?: GitRunner;
  install?: InstallRunner;
  writeLink?: typeof writeRepoLocalRegistryEntry;
}

export type InstallOutcome = "ok" | "failed" | "skipped";

export interface WorktreeRepositoryResult {
  repository: string;
  /** The main checkout the worktree belongs to. */
  checkout: string;
  path: string;
  branch: string;
  action: "created" | "reused";
  install: { command: string | null; outcome: InstallOutcome; reason?: string };
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

export interface PruneResult {
  removed: PruneEntry[];
  kept: (PruneEntry & { reason: string })[];
  warnings: string[];
}

const runGit: GitRunner = (cwd, args) =>
  new Promise<GitResult>((resolve) => {
    execFile(
      "git",
      args,
      { cwd, env: gitEnvironment(), maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

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
}

async function listWorktrees(git: GitRunner, repo: string): Promise<WorktreeEntry[] | null> {
  const result = await git(repo, ["worktree", "list", "--porcelain"]);
  if (result.code !== 0) return null;
  const entries = result.stdout.split(/\n\n+/).flatMap((block) => {
    let entryPath: string | null = null;
    let branch: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) entryPath = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/"))
        branch = line.slice("branch refs/heads/".length);
    }
    return entryPath ? [{ path: entryPath, branch }] : [];
  });
  return Promise.all(
    entries.map(async (entry) => ({ ...entry, path: await canonical(entry.path) })),
  );
}

/** The first existing checkout linked to the companion whose `origin` is the repository. */
async function linkedCheckout(
  companionPath: string,
  repository: string,
  git: GitRunner,
): Promise<string | null> {
  let repos: { path: string }[] = [];
  try {
    repos = (await readCompanionRegistry(companionPath)).repos;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const identities = await Promise.all(
    repos.map(async (repo) => {
      if (!(await exists(repo.path))) return null;
      // Raw config, not `remote get-url`, so `insteadOf` rewrites do not change the identity.
      const remote = await git(repo.path, ["config", "--get", "remote.origin.url"]);
      return remote.code === 0 ? identityOf(remote.stdout.trim()) : null;
    }),
  );
  // The first match in registry order decides.
  const index = identities.findIndex(
    (identity) => identity?.toLowerCase() === repository.toLowerCase(),
  );
  return index === -1 ? null : repos[index]!.path;
}

interface Plan {
  repository: string;
  checkout: string;
  target: string;
  branch: string;
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
): Promise<{ plans: Plan[]; diagnostics: string[] }> {
  const checked = await Promise.all(
    target.repositories.map((repository) =>
      planRepository(companionPath, target.id, repository, git),
    ),
  );
  return {
    plans: checked.filter((entry): entry is Plan => !Array.isArray(entry)),
    diagnostics: checked.flatMap((entry) => (Array.isArray(entry) ? entry : [])),
  };
}

/** One repository's plan, or the diagnostics that stop the run. */
async function planRepository(
  companionPath: string,
  worksetId: string,
  repository: string,
  git: GitRunner,
): Promise<Plan | string[]> {
  const branch = defaultDeliveryBranch(worksetId);
  const resolution = await resolveWorksetBranch(companionPath, worksetId, repository);
  if (resolution.id === null) {
    return resolution.diagnostics.map((line) => `${repository}: ${line}`);
  }
  const linked = await linkedCheckout(companionPath, repository, git);
  if (!linked) return [`${repository}: not linked to ${companionPath} on this machine`];
  const entries = await listWorktrees(git, linked);
  const main = entries?.[0];
  if (!main) return [`${repository}: cannot list the worktrees of ${linked}`];
  const target = await canonical(worktreePathFor(main.path, worksetId));
  const atTarget = entries.find((entry) => entry.path === target);
  const reuse = atTarget?.branch === branch;
  if (!reuse && (atTarget || (await exists(target)))) {
    return [`${repository}: ${target} exists and is not a worktree of ${repository} on ${branch}`];
  }
  const elsewhere = entries.find((entry) => entry.branch === branch && entry.path !== target);
  if (elsewhere) return [`${repository}: ${branch} is already checked out at ${elsewhere.path}`];
  return { repository, checkout: main.path, target, branch, reuse };
}

async function addWorktree(git: GitRunner, plan: Plan, warnings: string[]): Promise<string | null> {
  const fetched = await git(plan.checkout, ["fetch", "--prune", "origin"]);
  if (fetched.code !== 0) {
    warnings.push(
      `${plan.repository}: fetching origin failed, using local refs: ${fetched.stderr.trim()}`,
    );
  }
  const has = async (ref: string) =>
    (await git(plan.checkout, ["rev-parse", "--verify", "--quiet", ref])).code === 0;
  const { branch, target } = plan;
  const add = (await has(`refs/heads/${branch}`))
    ? ["worktree", "add", target, branch]
    : (await has(`refs/remotes/origin/${branch}`))
      ? ["worktree", "add", "--track", "-b", branch, target, `origin/${branch}`]
      : ["worktree", "add", "--no-track", "-b", branch, target, "origin/HEAD"];
  const result = await git(plan.checkout, add);
  return result.code === 0 ? null : `creating the worktree failed: ${result.stderr.trim()}`;
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
  const { plans, diagnostics } = await planWorktrees(companionPath, target, git);
  if (diagnostics.length > 0) {
    return { workset: worksetId, ok: false, repositories: [], diagnostics, warnings: [] };
  }
  const warnings: string[] = [];
  const repositories: WorktreeRepositoryResult[] = [];
  for (const plan of plans) {
    // oxlint-disable-next-line no-await-in-loop -- one repository at a time, installs included
    repositories.push(await realize(companionPath, plan, options, git, deps, warnings));
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
    missingEnv: [],
  };
  if (!plan.reuse) {
    const failure = await addWorktree(git, plan, warnings);
    if (failure)
      return { ...result, install: { ...result.install, reason: NOT_CREATED }, error: failure };
  }
  try {
    // Named like `mate working link` names it: the repository part of the origin.
    await (deps.writeLink ?? writeRepoLocalRegistryEntry)(
      plan.target,
      companionPath,
      { id: plan.repository.split("/").at(-1)!, path: plan.target },
      "existing",
    );
  } catch (error) {
    result.error = `linking the worktree failed: ${errorMessage(error)}`;
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
  result.missingEnv = await missingEnvFiles(git, plan.checkout, plan.target);
  return result;
}

/** Why a worktree must stay, or null when it is clean and every commit is on a remote. */
async function keepReason(git: GitRunner, worktree: string): Promise<string | null> {
  const status = await git(worktree, ["status", "--porcelain"]);
  if (status.code !== 0) return `cannot read its status: ${status.stderr.trim()}`;
  if (status.stdout.trim()) return "uncommitted changes or untracked files";
  const unpushed = await git(worktree, ["log", "--oneline", "HEAD", "--not", "--remotes"]);
  if (unpushed.code !== 0) return `cannot read its commits: ${unpushed.stderr.trim()}`;
  if (unpushed.stdout.trim()) return "commits on no remote";
  return null;
}

async function pruneRepository(
  companionPath: string,
  worksetId: string,
  repository: string,
  git: GitRunner,
  result: PruneResult,
): Promise<void> {
  const linked = await linkedCheckout(companionPath, repository, git);
  if (!linked) return;
  const entries = await listWorktrees(git, linked);
  const main = entries?.[0];
  if (!main) {
    result.warnings.push(`${repository}: cannot list the worktrees of ${linked}`);
    return;
  }
  const target = await canonical(worktreePathFor(main.path, worksetId));
  if (!entries.some((entry) => entry.path === target)) return;
  const entry = { workset: worksetId, repository, path: target };
  const reason = await keepReason(git, target);
  if (reason) {
    result.kept.push({ ...entry, reason });
    return;
  }
  const removed = await git(main.path, ["worktree", "remove", target]);
  if (removed.code === 0) result.removed.push(entry);
  else result.kept.push({ ...entry, reason: removed.stderr.trim() || "git refused" });
}

/**
 * Removes the worktrees of the given (Done) Worksets that are clean and fully pushed,
 * without `--force`, and never deletes a branch. Every other worktree stays.
 */
export async function pruneWorksetWorktrees(
  companionPath: string,
  done: readonly WorksetRecord[],
  deps: WorktreeDeps = {},
): Promise<PruneResult> {
  const git = deps.git ?? runGit;
  const result: PruneResult = { removed: [], kept: [], warnings: [] };
  for (const record of done) {
    for (const repository of record.repositories) {
      // oxlint-disable-next-line no-await-in-loop -- Git operations on shared checkouts, one at a time
      await pruneRepository(companionPath, record.id, repository, git, result);
    }
  }
  return result;
}
