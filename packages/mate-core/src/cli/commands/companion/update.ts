import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import {
  createStartupProgress,
  type StartupProgressController,
} from "../../../lib/components/startup-progress";
import { ConfigStore } from "../../../lib/orchestrator/config-store";
import { writeEngineFloor } from "../../../lib/orchestrator/engine-floor";
import {
  refreshWorkingClaudeLinks,
  type LinkRefreshResult,
} from "../../../lib/orchestrator/refresh-working-claude-links";
import type { FrameworkConfig } from "../../../lib/orchestrator/types";
import {
  fetchLatestVersion,
  getCurrentVersion,
  isCanaryVersion,
  isNewer,
} from "../../../lib/update-checker";
import { resolveCompanionRuntime } from "../../../runtime/env";
import {
  syncCompanionFiles,
  untrackManagedSkillCopies,
  type CompanionSyncOptions,
} from "../../../tools/setup";
import type { ManagedOutputOwner, ManagedOutputReport } from "../../../tools/setup/plugin";
import { runCommand } from "../../../tools/setup/utils";
import { confirm } from "../../confirm";
import { defaultGitOps, type GitOps } from "../artifact/finish/git";
import { resolveCompanionPath } from "./tui";
import { errorMessage } from "../../../runtime/error-message";

/** Snapshot marker for a changed path that no longer exists on disk. */
export const DELETED = "<deleted>";

const SKILLS_LOCKFILE = "skills-lock.json";

/**
 * The side the sync reported owning `changedPath`: the path itself or an ancestor
 * was reported. A collapsed `dir/` that only contains a reported entry stays
 * unowned, since porcelain hides what else changed inside it.
 */
export function ownerOf(
  changedPath: string,
  report: ManagedOutputReport,
): ManagedOutputOwner | undefined {
  const target = changedPath.replace(/\/+$/, "");
  return report.find((entry) => target === entry.path || target.startsWith(`${entry.path}/`))
    ?.owner;
}

function frameworkConfigPath(companionPath: string): string {
  return path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
}

async function hashTree(absolute: string, hash: crypto.Hash, relative: string): Promise<void> {
  const stat = await fs.lstat(absolute);
  if (stat.isDirectory()) {
    const entries = (await fs.readdir(absolute)).toSorted();
    for (const entry of entries) {
      await hashTree(path.join(absolute, entry), hash, path.posix.join(relative, entry));
    }
    return;
  }
  hash.update(`${relative}\0`);
  hash.update(stat.isSymbolicLink() ? await fs.readlink(absolute) : await fs.readFile(absolute));
  hash.update("\0");
}

/** Porcelain collapses an untracked directory into one `dir/` entry, so directories hash their whole tree. */
async function snapshotPath(companionPath: string, relativePath: string): Promise<string> {
  const absolute = path.join(companionPath, relativePath);
  try {
    const hash = crypto.createHash("sha256");
    await hashTree(absolute, hash, ".");
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DELETED;
    throw error;
  }
}

export interface CompanionUpdateDeps {
  resolveCompanionPath: typeof resolveCompanionPath;
  resolveProjectedCompanionPath: (cwd: string) => string | undefined;
  getCurrentVersion: () => string;
  fetchLatestVersion: () => Promise<string>;
  loadConfig: (companionPath: string) => Promise<FrameworkConfig>;
  syncCompanionFiles: (
    companionPath: string,
    config: FrameworkConfig,
    options: CompanionSyncOptions,
  ) => Promise<ManagedOutputReport>;
  /** Removes the Mate skill copies the managed `.gitignore` lists from the index; returns their paths. */
  untrackSkillCopies: (companionPath: string, config: FrameworkConfig) => Promise<string[]>;
  /** Returns true when the file was rewritten. */
  writeEngineFloor: (companionPath: string, range: string) => Promise<boolean>;
  /** Re-links the companion's Claude skills and commands into its wrapped Working Repositories. */
  refreshWorkingClaudeLinks: (
    companionPath: string,
    config: FrameworkConfig,
  ) => Promise<LinkRefreshResult[]>;
  hasSkillsLock: (companionPath: string) => Promise<boolean>;
  runSkillsUpdate: (companionPath: string) => Promise<void>;
  createGitOps: (companionPath: string) => GitOps;
  snapshotPath: (companionPath: string, relativePath: string) => Promise<string>;
  confirm: (question: string) => Promise<boolean>;
  isInteractive: () => boolean;
  createProgress: typeof createStartupProgress;
}

export const companionUpdateDeps: CompanionUpdateDeps = {
  resolveCompanionPath,
  resolveProjectedCompanionPath: (cwd) =>
    resolveCompanionRuntime(process.env, cwd).context.companionPath || undefined,
  getCurrentVersion,
  fetchLatestVersion,
  loadConfig: (companionPath) => new ConfigStore(frameworkConfigPath(companionPath)).load(),
  /** The Claude plugin folders it gathers are for a launch; an update ignores them. */
  async syncCompanionFiles(companionPath, config, options) {
    return (await syncCompanionFiles(companionPath, config, undefined, options)).managedOutput;
  },
  untrackSkillCopies: untrackManagedSkillCopies,
  writeEngineFloor,
  refreshWorkingClaudeLinks,
  hasSkillsLock: (companionPath) =>
    fs
      .access(path.join(companionPath, SKILLS_LOCKFILE))
      .then(() => true)
      .catch(() => false),
  runSkillsUpdate: (companionPath) =>
    runCommand("npx", ["skills", "update", "-p", "-y"], { cwd: companionPath }),
  createGitOps: (companionPath) => defaultGitOps(companionPath, undefined),
  snapshotPath,
  confirm,
  isInteractive: () => !!(process.stdin.isTTY && process.stdout.isTTY),
  createProgress: createStartupProgress,
};

export interface UpdateChanges {
  written: string[];
  conflict: string[];
  /** Mate-managed skills whose uncommitted edits the update replaced. */
  overwritten: string[];
}

/** Content snapshot of every uncommitted path, taken before the update writes. */
export async function snapshotChangedPaths(
  companionPath: string,
  git: GitOps,
): Promise<Map<string, string>> {
  const before = new Map<string, string>();
  for (const changed of await git.changedPaths()) {
    before.set(changed, await companionUpdateDeps.snapshotPath(companionPath, changed));
  }
  return before;
}

/**
 * Paths the update wrote, and the subset that already carried local edits (design D4).
 * `untracked` skill copies are Mate output: committed as deletions, never a conflict.
 */
export async function diffChangedPaths(
  companionPath: string,
  git: GitOps,
  before: Map<string, string>,
  report: ManagedOutputReport,
  untracked: readonly string[] = [],
): Promise<UpdateChanges> {
  const removals = new Set(untracked);
  const written: string[] = [];
  const conflict: string[] = [];
  const overwritten: string[] = [];
  for (const changed of await git.changedPaths()) {
    if (!before.has(changed)) written.push(changed);
  }
  const preexisting = await Promise.all(
    [...before].map(async ([changed, hash]) => {
      const after = await companionUpdateDeps.snapshotPath(companionPath, changed);
      return { changed, owner: ownerOf(changed, report), unchanged: after === hash };
    }),
  );
  for (const { changed, owner, unchanged } of preexisting) {
    if (removals.has(changed)) {
      written.push(changed);
      if (owner === "mate" && !unchanged) overwritten.push(changed);
      continue;
    }
    // Reported output is committed even when a local edit preceded the sync.
    if (!owner && unchanged) continue;
    written.push(changed);
    if (owner === "openspec" || (owner === "mate" && unchanged)) continue;
    (owner === "mate" ? overwritten : conflict).push(changed);
  }
  return {
    written: written.toSorted(),
    conflict: conflict.toSorted(),
    overwritten: overwritten.toSorted(),
  };
}

async function resolveCompanion(cwd: string): Promise<string | undefined> {
  const resolved = await companionUpdateDeps.resolveCompanionPath(cwd);
  if (resolved) return resolved;
  return companionUpdateDeps.resolveProjectedCompanionPath(cwd);
}

function fail(message: string): void {
  process.stderr.write(`${FRAMEWORK_NAME}: ${message}\n`);
  process.exitCode = 1;
}

function listPaths(paths: string[]): string {
  return paths.map((changed) => `  ${changed}`).join("\n");
}

function reportLinkRefresh(results: LinkRefreshResult[]): void {
  for (const result of results) {
    const where = result.repository?.path ?? "the linked Working Repositories";
    if (result.outcome === "written") {
      process.stdout.write(
        `${FRAMEWORK_NAME}: refreshed Claude skill and command links in ${where}.\n`,
      );
    } else if (result.outcome === "current") {
      process.stdout.write(`${FRAMEWORK_NAME}: Claude links already current in ${where}.\n`);
    } else {
      process.stderr.write(
        `${FRAMEWORK_NAME}: warning: could not refresh Claude links in ${where}: ${result.error}\n`,
      );
    }
  }
}

/** Version precondition; returns the running version when the update may proceed. */
async function checkVersion(progress: StartupProgressController): Promise<string | undefined> {
  const current = companionUpdateDeps.getCurrentVersion();
  if (isCanaryVersion(current)) {
    progress.stop();
    fail(
      `\`${FRAMEWORK_NAME} companion update\` requires a stable ${FRAMEWORK_NAME}; ${current} is a prerelease.`,
    );
    return undefined;
  }
  let latest: string;
  try {
    latest = await progress.step("registry", "Checking registry", () =>
      companionUpdateDeps.fetchLatestVersion(),
    );
  } catch (error) {
    progress.stop();
    fail(`could not check the registry for the newest version: ${errorMessage(error)}`);
    return undefined;
  }
  if (isNewer(latest, current)) {
    progress.stop();
    fail(
      [
        `${current} is installed, but the newest stable version is ${latest}.`,
        `  Run \`${FRAMEWORK_NAME} update\` first.`,
      ].join("\n"),
    );
    return undefined;
  }
  return current;
}

async function commitAndPush(
  git: GitOps,
  written: string[],
  removed: readonly string[],
  version: string,
  yes: boolean,
): Promise<void> {
  if (!yes && !companionUpdateDeps.isInteractive()) {
    process.stdout.write(
      `${FRAMEWORK_NAME}: not an interactive shell; changes left uncommitted. Re-run with --yes to commit and push.\n`,
    );
    return;
  }

  const message = `chore(${FRAMEWORK_NAME}): update companion to ${FRAMEWORK_NAME} ${version}`;
  if (!yes && !(await companionUpdateDeps.confirm(`Commit as "${message}"?`))) {
    process.stdout.write(`${FRAMEWORK_NAME}: changes left uncommitted.\n`);
    return;
  }
  try {
    await git.add(written);
    await git.commit(message, written, { removed });
  } catch (error) {
    fail(`commit failed: ${errorMessage(error)}`);
    return;
  }
  process.stdout.write(`${FRAMEWORK_NAME}: committed "${message}".\n`);

  if (!yes && !(await companionUpdateDeps.confirm("Push the commit?"))) return;
  if (!(await git.hasUpstream())) {
    process.stdout.write(
      `${FRAMEWORK_NAME}: the current branch has no upstream; the commit stays local.\n`,
    );
    return;
  }
  const pushed = await git.push();
  if (!pushed.ok) {
    fail(`push failed; the commit stays local.\n  ${pushed.error}`);
    return;
  }
  process.stdout.write(`${FRAMEWORK_NAME}: pushed.\n`);
}

/**
 * @command mate companion update
 * @description Regenerates the companion's Mate-managed files and skills with
 * the newest stable Mate, raises `engines.mate` to match, and offers to commit
 * and push exactly the files the update wrote.
 */
export async function runCompanionUpdateCommand(argv: string[]): Promise<void> {
  const unknown = argv.filter((arg) => arg !== "--yes");
  if (unknown.length > 0) {
    fail(`unknown argument for companion update: ${unknown.join(" ")}`);
    return;
  }
  const yes = argv.includes("--yes");

  const companionPath = await resolveCompanion(process.cwd());
  if (!companionPath) {
    fail(
      `no companion resolves for this directory. Run \`${FRAMEWORK_NAME} companion link\` first.`,
    );
    return;
  }

  const progress = companionUpdateDeps.createProgress("Updating companion");
  try {
    await updateCompanion(companionPath, yes, progress);
  } finally {
    progress.stop();
  }
}

async function updateCompanion(
  companionPath: string,
  yes: boolean,
  progress: StartupProgressController,
): Promise<void> {
  const version = await checkVersion(progress);
  if (!version) return;

  let git: GitOps;
  let before: Map<string, string>;
  try {
    git = companionUpdateDeps.createGitOps(companionPath);
    before = await snapshotChangedPaths(companionPath, git);
  } catch (error) {
    progress.stop();
    fail(errorMessage(error));
    return;
  }

  let config: FrameworkConfig;
  let report: ManagedOutputReport;
  let untracked: string[];
  try {
    ({ config, report, untracked } = await progress.step(
      "sync",
      "Syncing companion files",
      async () => {
        const loaded = await companionUpdateDeps.loadConfig(companionPath);
        // Only this command and setup regenerate OpenSpec output; launches leave it alone.
        const synced = await companionUpdateDeps.syncCompanionFiles(companionPath, loaded, {
          regenerateOpenSpec: true,
        });
        // After the sync wrote the managed `.gitignore`; a declined commit leaves the removals staged.
        const removed = await companionUpdateDeps.untrackSkillCopies(companionPath, loaded);
        return { config: loaded, report: synced, untracked: removed };
      },
    ));
  } catch (error) {
    progress.stop();
    fail(`companion file synchronization failed: ${errorMessage(error)}`);
    return;
  }
  // The reports, the skills refresh and the commit confirm below own the terminal.
  progress.stop();

  if (await companionUpdateDeps.hasSkillsLock(companionPath)) {
    try {
      await companionUpdateDeps.runSkillsUpdate(companionPath);
    } catch (error) {
      process.stderr.write(
        `${FRAMEWORK_NAME}: warning: third-party skill refresh failed: ${errorMessage(error)}\n`,
      );
    }
  }

  // Working Repositories are outside the companion, so their links never join its commit.
  reportLinkRefresh(await companionUpdateDeps.refreshWorkingClaudeLinks(companionPath, config));

  try {
    await companionUpdateDeps.writeEngineFloor(companionPath, `>=${version}`);
  } catch (error) {
    fail(`could not set engines.${FRAMEWORK_NAME}: ${errorMessage(error)}`);
    return;
  }

  const { written, conflict, overwritten } = await diffChangedPaths(
    companionPath,
    git,
    before,
    report,
    untracked,
  );
  if (written.length === 0) {
    process.stdout.write(
      `${FRAMEWORK_NAME}: ${companionPath} is already up to date with ${FRAMEWORK_NAME} ${version}.\n`,
    );
    return;
  }
  if (conflict.length > 0) {
    fail(
      [
        "the update rewrote files that already had uncommitted changes; local edits and update output can no longer be separated, so nothing is committed:",
        listPaths(conflict),
        ...(untracked.length > 0
          ? [
              "Mate skill copies were removed from the Git index and stay staged as deletions; the files are still on disk.",
            ]
          : []),
      ].join("\n"),
    );
    return;
  }

  if (overwritten.length > 0) {
    process.stderr.write(
      [
        `${FRAMEWORK_NAME}: warning: the update overwrote local edits to Mate-managed skills:`,
        listPaths(overwritten),
        "",
      ].join("\n"),
    );
  }
  process.stdout.write(
    [`${FRAMEWORK_NAME}: the update changed ${companionPath}:`, listPaths(written), ""].join("\n"),
  );
  await commitAndPush(git, written, untracked, version, yes);
}
