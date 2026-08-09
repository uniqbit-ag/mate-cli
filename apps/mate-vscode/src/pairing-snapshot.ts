import type {
  CompanionHealth,
  WorkspaceInventoryCompanion,
  WorkspaceInventoryPairing,
  WorkspaceInventoryV1,
} from "./schema";

/** One validated inventory response, frozen so a refresh always replaces it wholesale rather than mutating in place. */
export interface PairingSnapshot {
  readonly companions: readonly WorkspaceInventoryCompanion[];
  readonly pairings: readonly WorkspaceInventoryPairing[];
}

export function buildPairingSnapshot(inventory: WorkspaceInventoryV1): PairingSnapshot {
  return Object.freeze({
    companions: Object.freeze(inventory.companions.map((c) => Object.freeze({ ...c }))),
    pairings: Object.freeze(inventory.pairings.map((p) => Object.freeze({ ...p }))),
  });
}

export interface WorkingRepositoryGroup {
  repositoryId: string;
  repositoryPath: string;
  pairings: WorkspaceInventoryPairing[];
}

export interface CompanionGroup {
  companionPath: string;
  companionHealth: CompanionHealth;
  companionDiagnostic?: string;
  pairings: WorkspaceInventoryPairing[];
}

/** Groups pairings by working-repository id; a repo linked from N companions yields N pairings under one group. */
export function projectByWorkingRepository(snapshot: PairingSnapshot): WorkingRepositoryGroup[] {
  const groups = new Map<string, WorkingRepositoryGroup>();
  for (const pairing of snapshot.pairings) {
    const key = pairing.repository.id;
    const existing = groups.get(key);
    if (existing) {
      existing.pairings.push(pairing);
    } else {
      groups.set(key, {
        repositoryId: pairing.repository.id,
        repositoryPath: pairing.repository.path,
        pairings: [pairing],
      });
    }
  }
  return [...groups.values()].toSorted((a, b) => a.repositoryId.localeCompare(b.repositoryId));
}

/** Groups pairings by companion path. Every registered companion appears, even with zero pairings. */
export function projectByCompanion(snapshot: PairingSnapshot): CompanionGroup[] {
  const groups = new Map<string, CompanionGroup>();
  for (const companion of snapshot.companions) {
    groups.set(companion.path, {
      companionPath: companion.path,
      companionHealth: companion.health,
      ...(companion.diagnostic ? { companionDiagnostic: companion.diagnostic } : {}),
      pairings: [],
    });
  }
  for (const pairing of snapshot.pairings) {
    const group = groups.get(pairing.companionPath);
    if (group) {
      group.pairings.push(pairing);
    } else {
      // Defensive: a pairing referencing a companion absent from the
      // companions array (shouldn't happen from a well-formed Mate
      // response) still surfaces rather than being silently dropped.
      groups.set(pairing.companionPath, {
        companionPath: pairing.companionPath,
        companionHealth: "ready",
        pairings: [pairing],
      });
    }
  }
  return [...groups.values()].toSorted((a, b) => a.companionPath.localeCompare(b.companionPath));
}
