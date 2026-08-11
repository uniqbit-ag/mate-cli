import * as vscode from "vscode";

import type { PairingSnapshot } from "./pairing-snapshot";
import type { WorkspaceInventoryPairing } from "./schema";
import type { MateViewState } from "./tree-model";

export type PairingPresence =
  | { state: "unpaired" }
  | { state: "paired"; pairing: WorkspaceInventoryPairing }
  | { state: "drift"; pairing: WorkspaceInventoryPairing };

/**
 * Matches every open workspace folder (not just the first — a window may
 * already be multi-root) against every pairing's working-repository and
 * companion root paths. Exact-root match only, never a prefix match, so a
 * subdirectory of a working repo does not falsely register as paired.
 */
export function resolvePairingPresence(
  folderPaths: readonly string[],
  snapshot: PairingSnapshot,
): PairingPresence {
  let drifted: WorkspaceInventoryPairing | undefined;
  for (const folder of folderPaths) {
    for (const pairing of snapshot.pairings) {
      if (pairing.repository.path !== folder && pairing.companionPath !== folder) continue;
      if (pairing.health === "ready") return { state: "paired", pairing };
      drifted ??= pairing;
    }
  }
  return drifted ? { state: "drift", pairing: drifted } : { state: "unpaired" };
}

function presenceForState(folderPaths: readonly string[], state: MateViewState): PairingPresence {
  return state.status === "ready"
    ? resolvePairingPresence(folderPaths, state.snapshot)
    : { state: "unpaired" };
}

function renderPresence(item: vscode.StatusBarItem, presence: PairingPresence): void {
  switch (presence.state) {
    case "paired":
      item.text = `$(check) Mate: ${presence.pairing.repository.id}`;
      item.tooltip = `Paired with ${presence.pairing.companionPath}`;
      item.backgroundColor = undefined;
      break;
    case "drift":
      item.text = `$(warning) Mate: ${presence.pairing.repository.id}`;
      item.tooltip = `Pairing health: ${presence.pairing.health}${
        presence.pairing.diagnostic ? ` — ${presence.pairing.diagnostic}` : ""
      }`;
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      break;
    case "unpaired":
      item.text = "$(circle-slash) Mate: unpaired";
      item.tooltip = "No open workspace folder matches a registered Mate pairing.";
      item.backgroundColor = undefined;
      break;
  }
}

export const REVEAL_STATUS_BAR_PAIRING_COMMAND = "mate.revealPairingFromStatusBar";

export interface StatusBarHost {
  getState: () => MateViewState;
  getWorkspaceFolderPaths: () => readonly string[];
  revealPairing: (pairing: WorkspaceInventoryPairing) => void;
}

/** Owns the one always-visible status bar item reflecting the current window's pairing state. */
export class MateStatusBarItem {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly host: StatusBarHost) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.item.command = REVEAL_STATUS_BAR_PAIRING_COMMAND;
    this.item.show();
  }

  /** Recomputes presence from the host's current state — call from the same refresh cycle the tree views use. */
  render(): void {
    renderPresence(
      this.item,
      presenceForState(this.host.getWorkspaceFolderPaths(), this.host.getState()),
    );
  }

  /** Handler for {@link REVEAL_STATUS_BAR_PAIRING_COMMAND}: reveals the matched pairing, or no-ops when unpaired. */
  handleClick(): void {
    const presence = presenceForState(this.host.getWorkspaceFolderPaths(), this.host.getState());
    if (presence.state === "unpaired") {
      void vscode.window.showInformationMessage(
        "Mate: no open workspace folder matches a registered pairing. Run `mate companion link` from a working repository, then refresh.",
      );
      return;
    }
    this.host.revealPairing(presence.pairing);
  }

  dispose(): void {
    this.item.dispose();
  }
}
