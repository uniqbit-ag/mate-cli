import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../../framework";
import { gitEnvironment } from "../../../runtime/companion-git";
import { checkoutCommonDir } from "../../../runtime/git-layout";
import type { RootKind } from "../../../lib/orchestrator/root-context";
import {
  collectWorkspaceInventory,
  type WorkspaceInventoryPairingEntry,
  type WorkspaceInventoryV1,
} from "../../../lib/orchestrator/workspace-inventory";
import { umbrellaFolderOf, umbrellaMirroredBy } from "../../../lib/orchestrator/umbrella-checkouts";
import {
  cleanupWorkingRepository,
  type WorkingRepoCleanupResult,
} from "../../../tools/setup/working-repo-cleanup";

const execFileAsync = promisify(execFile);

async function canonicalPath(candidatePath: string): Promise<string> {
  try {
    return await fs.realpath(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

export interface WorkingCleanupCommandDeps {
  cwd: string;
  resolveGitRoot: (cwd: string) => Promise<string | null>;
  /** Outside Git: the linked Umbrella Repository or mirrored umbrella worktree holding `cwd`. */
  resolveUmbrella: (cwd: string) => Promise<string | null>;
  localRootKind: (repoPath: string) => Promise<RootKind | null>;
  collectInventory: () => Promise<WorkspaceInventoryV1>;
  cleanup: (
    repoPath: string,
    registeredCompanionPaths: string[],
  ) => Promise<WorkingRepoCleanupResult>;
}

async function resolveGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      env: gitEnvironment(),
    });
    return canonicalPath(stdout.trim());
  } catch {
    return null;
  }
}

/** Default `resolveUmbrella`: from files alone, canonical like the Git root. */
export async function resolveUmbrella(cwd: string): Promise<string | null> {
  const folder = umbrellaFolderOf(await canonicalPath(cwd));
  return folder ? canonicalPath(folder) : null;
}

async function localRootKind(repoPath: string): Promise<RootKind | null> {
  try {
    const raw = await fs.readFile(
      path.join(repoPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
      "utf8",
    );
    const config = parse(raw) as { type?: string } | null;
    if (config?.type === "working" || config?.type === "hub") return config.type;
    return "companion";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "companion";
  }
}

const defaultDeps: WorkingCleanupCommandDeps = {
  cwd: process.cwd(),
  resolveGitRoot,
  resolveUmbrella,
  localRootKind,
  collectInventory: collectWorkspaceInventory,
  cleanup: cleanupWorkingRepository,
};

/**
 * The pairings of the Checkout at `repoPath`: by path, else by clone for
 * another Checkout of a linked clone (design Decision 7). The recorded clone
 * still counts once the entry's folder is gone.
 */
async function pairingsOf(
  repoPath: string,
  pairings: WorkspaceInventoryPairingEntry[],
): Promise<{ matches: WorkspaceInventoryPairingEntry[]; byClone: boolean }> {
  const resolved = await Promise.all(
    pairings.map(async (pairing) => ({
      pairing,
      repositoryPath: await canonicalPath(pairing.repository.path),
    })),
  );
  const atPath = resolved.filter(({ repositoryPath }) => repositoryPath === repoPath);
  if (atPath.length > 0) return { matches: atPath.map(({ pairing }) => pairing), byClone: false };
  const clone = checkoutCommonDir(repoPath);
  const ofClone = resolved.filter(
    ({ pairing, repositoryPath }) =>
      clone !== null &&
      (checkoutCommonDir(repositoryPath) ?? pairing.repository.gitCommonDir) === clone,
  );
  return { matches: ofClone.map(({ pairing }) => pairing), byClone: true };
}

/**
 * The pairings of an umbrella folder: the umbrella's own, which a mirrored worktree
 * `<umbrella>.worktrees/<id>` shares, since the registry never lists that folder.
 */
async function umbrellaPairingsOf(
  folder: string,
  pairings: WorkspaceInventoryPairingEntry[],
): Promise<WorkspaceInventoryPairingEntry[]> {
  const mirrored = umbrellaMirroredBy(folder);
  const served = new Set([folder, ...(mirrored ? [await canonicalPath(mirrored)] : [])]);
  const resolved = await Promise.all(
    pairings.map(async (pairing) =>
      served.has(await canonicalPath(pairing.repository.path)) ? pairing : null,
    ),
  );
  return resolved.filter((pairing): pairing is WorkspaceInventoryPairingEntry => pairing !== null);
}

const NOT_LINKED = `${FRAMEWORK_NAME}: working cleanup must run from a linked Git working repository or Umbrella Repository\n`;

export async function runWorkingCleanupCommand(
  argv: string[],
  deps: WorkingCleanupCommandDeps = defaultDeps,
): Promise<void> {
  if (argv.length > 0) {
    process.stderr.write(`${FRAMEWORK_NAME}: usage: ${FRAMEWORK_NAME} working cleanup\n`);
    process.exitCode = 1;
    return;
  }
  const gitRoot = await deps.resolveGitRoot(deps.cwd);
  // Its children are Checkouts of their own; only the folder's integration is removed.
  const umbrella = gitRoot ? null : await deps.resolveUmbrella(deps.cwd);
  const repoPath = gitRoot ?? umbrella;
  if (!repoPath) {
    process.stderr.write(NOT_LINKED);
    process.exitCode = 1;
    return;
  }
  const kind = await deps.localRootKind(repoPath);
  if (kind === "companion" || kind === "hub") {
    process.stderr.write(
      `${FRAMEWORK_NAME}: working cleanup is unavailable in a ${kind} repository\n`,
    );
    process.exitCode = 1;
    return;
  }
  const { pairings } = await deps.collectInventory();
  const { matches, byClone } = umbrella
    ? { matches: await umbrellaPairingsOf(umbrella, pairings), byClone: false }
    : await pairingsOf(repoPath, pairings);
  if (matches.length === 0) {
    process.stderr.write(NOT_LINKED);
    process.exitCode = 1;
    return;
  }
  const companionPaths = [...new Set(matches.map((pairing) => pairing.companionPath))];
  const result = await deps.cleanup(repoPath, companionPaths);
  const kept = result.kept.map(
    ({ label, keptFor }) => `${label} (still needed by ${keptFor.join(", ")})`,
  );
  const keptDetail = kept.length > 0 ? `kept: ${kept.join(", ")}` : null;
  for (const warning of result.warnings) {
    console.error(`${FRAMEWORK_NAME}: warning: ${warning}`);
  }
  if (!result.changed) {
    const suffix = keptDetail ? ` (${keptDetail})` : "";
    console.log(`${FRAMEWORK_NAME}: working repository already clean${suffix}`);
    return;
  }
  const details = [
    ...(result.removed.length > 0 ? [`removed: ${result.removed.join(", ")}`] : []),
    ...(result.updated.length > 0 ? [`updated: ${result.updated.join(", ")}`] : []),
    ...(keptDetail ? [keptDetail] : []),
  ];
  console.log(`${FRAMEWORK_NAME}: cleaned working repository (${details.join("; ")})`);
  if (byClone) {
    console.log(
      `${FRAMEWORK_NAME}: ${repoPath} is another Checkout of ${matches[0]!.repository.id}; ${FRAMEWORK_NAME} adopts it again the next time it runs here.`,
    );
  }
}
