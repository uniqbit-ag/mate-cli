import {
  collectWorkspaceInventory,
  type CompanionInventoryHealth,
  type PairingInventoryHealth,
} from "../../../lib/orchestrator/workspace-inventory";

export interface StudioInventoryPairing {
  repositoryId: string;
  repositoryPath: string;
  health: PairingInventoryHealth;
  ambiguous: boolean;
}

export interface StudioInventoryCompanion {
  path: string;
  health: CompanionInventoryHealth;
  diagnostic?: string;
  pairings: StudioInventoryPairing[];
}

export interface StudioInventory {
  companions: StudioInventoryCompanion[];
}

export interface StudioInventoryDeps {
  collectWorkspaceInventory?: typeof collectWorkspaceInventory;
}

/**
 * Companion-first projection of the machine-wide workspace inventory. Reads
 * only the aggregate the workspace surface already resolves — health,
 * ambiguity, and duplicate collapsing stay owned there.
 */
export async function collectStudioInventory(
  deps: StudioInventoryDeps = {},
): Promise<StudioInventory> {
  const collect = deps.collectWorkspaceInventory ?? collectWorkspaceInventory;
  const inventory = await collect();

  return {
    companions: inventory.companions.map((companion) => ({
      path: companion.path,
      health: companion.health,
      ...(companion.diagnostic ? { diagnostic: companion.diagnostic } : {}),
      pairings: inventory.pairings
        .filter((pairing) => pairing.companionPath === companion.path)
        .map((pairing) => ({
          repositoryId: pairing.repository.id,
          repositoryPath: pairing.repository.path,
          health: pairing.health,
          ambiguous: pairing.ambiguous,
        })),
    })),
  };
}
