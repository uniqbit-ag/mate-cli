import path from "node:path";

import { pathIsDirectory } from "./repo-local-registry";
import { readCompanionRegistry } from "./companion-registry-reader";
import { GlobalConfigStore } from "./global-config-store";
import type { LinkedRepository } from "./types";

/** Envelope version for `mate workspace list --json`; bump on any breaking shape change. */
export const WORKSPACE_INVENTORY_SCHEMA_VERSION = 1;

export type CompanionInventoryHealth = "ready" | "missing" | "unreadable";
export type PairingInventoryHealth =
  | "ready"
  | "missing-companion"
  | "missing-repository"
  | "unreadable";

export interface WorkspaceInventoryCompanionEntry {
  path: string;
  health: CompanionInventoryHealth;
  diagnostic?: string;
}

export interface WorkspaceInventoryPairingEntry {
  companionPath: string;
  repository: LinkedRepository;
  health: PairingInventoryHealth;
  ambiguous: boolean;
  diagnostic?: string;
}

export interface WorkspaceInventoryV1 {
  schemaVersion: 1;
  companions: WorkspaceInventoryCompanionEntry[];
  pairings: WorkspaceInventoryPairingEntry[];
}

export interface WorkspaceInventoryDeps {
  listCompanionPaths: () => Promise<string[]>;
  isDirectory: (candidatePath: string) => Promise<boolean>;
  readCompanionRegistry: typeof readCompanionRegistry;
}

export function defaultWorkspaceInventoryDeps(
  globalConfigStore = new GlobalConfigStore(),
): WorkspaceInventoryDeps {
  return {
    listCompanionPaths: () => globalConfigStore.list(),
    isDirectory: pathIsDirectory,
    readCompanionRegistry,
  };
}

interface CompanionScanResult {
  companionPath: string;
  health: CompanionInventoryHealth;
  diagnostic?: string;
  repos: LinkedRepository[];
}

async function scanCompanion(
  companionPath: string,
  deps: WorkspaceInventoryDeps,
): Promise<CompanionScanResult> {
  if (!(await deps.isDirectory(companionPath))) {
    return { companionPath, health: "missing", repos: [] };
  }

  try {
    const { repos } = await deps.readCompanionRegistry(companionPath);
    return { companionPath, health: "ready", repos };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { companionPath, health: "ready", repos: [] };
    }
    return {
      companionPath,
      health: "unreadable",
      diagnostic: error instanceof Error ? error.message : String(error),
      repos: [],
    };
  }
}

/**
 * Read-only aggregate over the global companion registry and each
 * companion's own linked-repository registry. Never migrates, repairs, or
 * removes registry state — partial failures are reported as data.
 */
export async function collectWorkspaceInventory(
  deps: WorkspaceInventoryDeps = defaultWorkspaceInventoryDeps(),
): Promise<WorkspaceInventoryV1> {
  const companionPaths = [
    ...new Set((await deps.listCompanionPaths()).map((p) => path.resolve(p))),
  ];

  const scans = await Promise.all(
    companionPaths.map((companionPath) => scanCompanion(companionPath, deps)),
  );

  const repoPathsByCompanion = new Map<string, Set<string>>();
  for (const scan of scans) {
    for (const repo of scan.repos) {
      const repoPath = path.resolve(repo.path);
      const companions = repoPathsByCompanion.get(repoPath) ?? new Set<string>();
      companions.add(scan.companionPath);
      repoPathsByCompanion.set(repoPath, companions);
    }
  }

  const repoExistence = new Map<string, boolean>();
  await Promise.all(
    [...repoPathsByCompanion.keys()].map(async (repoPath) => {
      repoExistence.set(repoPath, await deps.isDirectory(repoPath));
    }),
  );

  const companions: WorkspaceInventoryCompanionEntry[] = scans.map((scan) => ({
    path: scan.companionPath,
    health: scan.health,
    ...(scan.diagnostic ? { diagnostic: scan.diagnostic } : {}),
  }));

  const pairings: WorkspaceInventoryPairingEntry[] = scans.flatMap((scan) =>
    scan.repos.map((repo) => {
      const repoPath = path.resolve(repo.path);
      const ambiguous = (repoPathsByCompanion.get(repoPath)?.size ?? 0) > 1;
      const health: PairingInventoryHealth = repoExistence.get(repoPath)
        ? "ready"
        : "missing-repository";
      return {
        companionPath: scan.companionPath,
        repository: { id: repo.id, path: repoPath },
        health,
        ambiguous,
      };
    }),
  );

  companions.sort((a, b) => a.path.localeCompare(b.path));
  pairings.sort(
    (a, b) =>
      a.companionPath.localeCompare(b.companionPath) ||
      a.repository.id.localeCompare(b.repository.id) ||
      a.repository.path.localeCompare(b.repository.path),
  );

  return { schemaVersion: WORKSPACE_INVENTORY_SCHEMA_VERSION, companions, pairings };
}
