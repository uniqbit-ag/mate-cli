import type { OpenSpecChangeSummary } from "./openspec-schema";

export interface OpenSpecCompanionChanges {
  companionPath: string;
  changes: readonly OpenSpecChangeSummary[];
}

export type OpenSpecTreeNode =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string }
  | ({ kind: "companion-group" } & OpenSpecCompanionChanges)
  | ({ kind: "change"; companionPath: string } & OpenSpecChangeSummary);

export type OpenSpecViewState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error"; message: string }
  | { status: "ready"; companions: readonly OpenSpecCompanionChanges[] };

/** Root nodes: one group per companion, mirroring how Workspaces/Companions group pairings by their own roots. */
export function rootNodesForOpenSpecState(state: OpenSpecViewState): OpenSpecTreeNode[] {
  switch (state.status) {
    case "loading":
      return [{ kind: "loading" }];
    case "unavailable":
      return [{ kind: "unavailable" }];
    case "error":
      return [{ kind: "error", message: state.message }];
    case "ready":
      return state.companions.length === 0
        ? [{ kind: "empty" }]
        : state.companions.map((group) => ({ kind: "companion-group", ...group }));
  }
}

/** Children of a companion group: one leaf per active change, or an empty placeholder when it has none. */
export function childrenOfOpenSpecCompanionGroup(
  group: OpenSpecCompanionChanges,
): OpenSpecTreeNode[] {
  return group.changes.length === 0
    ? [{ kind: "empty" }]
    : group.changes.map((change) => ({
        kind: "change",
        companionPath: group.companionPath,
        ...change,
      }));
}
