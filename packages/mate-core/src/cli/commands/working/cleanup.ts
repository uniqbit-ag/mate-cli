import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../../framework";
import type { RootKind } from "../../../lib/orchestrator/root-context";
import {
  collectWorkspaceInventory,
  type WorkspaceInventoryV1,
} from "../../../lib/orchestrator/workspace-inventory";
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
  localRootKind: (repoPath: string) => Promise<RootKind | null>;
  collectInventory: () => Promise<WorkspaceInventoryV1>;
  cleanup: (
    repoPath: string,
    registeredCompanionPaths: string[],
  ) => Promise<WorkingRepoCleanupResult>;
}

async function resolveGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    return canonicalPath(stdout.trim());
  } catch {
    return null;
  }
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
  localRootKind,
  collectInventory: collectWorkspaceInventory,
  cleanup: cleanupWorkingRepository,
};

export async function runWorkingCleanupCommand(
  argv: string[],
  deps: WorkingCleanupCommandDeps = defaultDeps,
): Promise<void> {
  if (argv.length > 0) {
    process.stderr.write(`${FRAMEWORK_NAME}: usage: ${FRAMEWORK_NAME} working cleanup\n`);
    process.exitCode = 1;
    return;
  }
  const repoPath = await deps.resolveGitRoot(deps.cwd);
  if (!repoPath) {
    process.stderr.write(
      `${FRAMEWORK_NAME}: working cleanup must run from a linked Git working repository\n`,
    );
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
  const inventory = await deps.collectInventory();
  const resolvedPairings = await Promise.all(
    inventory.pairings.map(async (pairing) => ({
      pairing,
      repositoryPath: await canonicalPath(pairing.repository.path),
    })),
  );
  const matches = resolvedPairings
    .filter(({ repositoryPath }) => repositoryPath === repoPath)
    .map(({ pairing }) => pairing);
  if (matches.length === 0) {
    process.stderr.write(
      `${FRAMEWORK_NAME}: working cleanup must run from a linked Git working repository\n`,
    );
    process.exitCode = 1;
    return;
  }
  const companionPaths = [...new Set(matches.map((pairing) => pairing.companionPath))];
  const result = await deps.cleanup(repoPath, companionPaths);
  if (!result.changed) {
    console.log(`${FRAMEWORK_NAME}: working repository already clean`);
    return;
  }
  const details = [
    ...(result.removed.length > 0 ? [`removed: ${result.removed.join(", ")}`] : []),
    ...(result.updated.length > 0 ? [`updated: ${result.updated.join(", ")}`] : []),
  ];
  console.log(`${FRAMEWORK_NAME}: cleaned working repository (${details.join("; ")})`);
}
