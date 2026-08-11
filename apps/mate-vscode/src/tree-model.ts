import {
  type CompanionGroup,
  type PairingSnapshot,
  projectByCompanion,
  projectByWorkingRepository,
  type WorkingRepositoryGroup,
} from "./pairing-snapshot";
import type { WorkspaceInventoryPairing } from "./schema";

export type MateTreeNode =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string }
  | ({ kind: "working-repository" } & WorkingRepositoryGroup)
  | ({ kind: "companion-group" } & CompanionGroup)
  | {
      kind: "pairing";
      pairing: WorkspaceInventoryPairing;
      contextValue: string;
      description: string;
    };

export function isPairingLaunchable(pairing: WorkspaceInventoryPairing, trusted: boolean): boolean {
  return trusted && pairing.health === "ready";
}

export function isPairingOpenable(pairing: WorkspaceInventoryPairing): boolean {
  return pairing.health === "ready";
}

export function isRepositoryRootAvailable(pairing: WorkspaceInventoryPairing): boolean {
  return pairing.health === "ready";
}

/**
 * Space-separated token string consumed by `view/item/context` `when`
 * clauses (`viewItem =~ /\btoken\b/`) — never mutates or repairs anything,
 * purely a projection of the pairing-capability predicates above, so the
 * tree's `viewItem` and any other caller (e.g. the quick-pick selector)
 * share one notion of "is this pairing launchable/openable".
 */
export function pairingContextValue(pairing: WorkspaceInventoryPairing, trusted: boolean): string {
  const tokens = ["pairing"];
  if (isRepositoryRootAvailable(pairing)) tokens.push("pairing-repo-available");
  if (isPairingOpenable(pairing)) tokens.push("pairing-open");
  if (isPairingLaunchable(pairing, trusted)) tokens.push("pairing-launchable");
  return tokens.join(" ");
}

function pairingNode(
  pairing: WorkspaceInventoryPairing,
  trusted: boolean,
  description: string,
): MateTreeNode {
  return {
    kind: "pairing",
    pairing,
    contextValue: pairingContextValue(pairing, trusted),
    description,
  };
}

export type MateViewState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: PairingSnapshot };

/** Root-level nodes for either view, folding activation/refresh state and grouping into one call. */
export function rootNodesForState(
  state: MateViewState,
  grouping: "working-repository" | "companion",
): MateTreeNode[] {
  switch (state.status) {
    case "loading":
      return [{ kind: "loading" }];
    case "unavailable":
      return [{ kind: "unavailable" }];
    case "error":
      return [{ kind: "error", message: state.message }];
    case "ready":
      return grouping === "working-repository"
        ? buildWorkingRepositoryRoots(state.snapshot)
        : buildCompanionRoots(state.snapshot);
  }
}

export function buildWorkingRepositoryRoots(snapshot: PairingSnapshot): MateTreeNode[] {
  const groups = projectByWorkingRepository(snapshot);
  if (groups.length === 0) return [{ kind: "empty" }];
  return groups.map((group) => ({ kind: "working-repository", ...group }));
}

/** Children of a working-repository root: one leaf per companion it's paired with. */
export function childrenOfWorkingRepository(
  group: WorkingRepositoryGroup,
  trusted: boolean,
): MateTreeNode[] {
  return group.pairings
    .toSorted((a, b) => a.companionPath.localeCompare(b.companionPath))
    .map((pairing) => pairingNode(pairing, trusted, pairing.companionPath));
}

export function buildCompanionRoots(snapshot: PairingSnapshot): MateTreeNode[] {
  const groups = projectByCompanion(snapshot);
  if (groups.length === 0) return [{ kind: "empty" }];
  return groups.map((group) => ({ kind: "companion-group", ...group }));
}

/** Children of a companion root: one leaf per working repository it links. */
export function childrenOfCompanionGroup(group: CompanionGroup, trusted: boolean): MateTreeNode[] {
  return group.pairings
    .toSorted((a, b) => a.repository.id.localeCompare(b.repository.id))
    .map((pairing) => pairingNode(pairing, trusted, pairing.repository.path));
}
