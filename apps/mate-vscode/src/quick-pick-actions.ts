import * as vscode from "vscode";

import {
  type CommandsHost,
  copyCompanionPath,
  copyWorkingRepositoryPath,
  launchAgent,
  openWorkspace,
  revealCompanion,
  revealWorkingRepository,
} from "./commands";
import type { WorkspaceInventoryPairing } from "./schema";
import {
  isPairingLaunchable,
  isPairingOpenable,
  isRepositoryRootAvailable,
  type MateTreeNode,
  type MateViewState,
} from "./tree-model";

export interface QuickPickActionsHost extends CommandsHost {
  getState: () => MateViewState;
}

function pairingsFromState(state: MateViewState): readonly WorkspaceInventoryPairing[] {
  return state.status === "ready" ? state.snapshot.pairings : [];
}

/** Wraps a pairing back into the `{kind: "pairing"}` shape every action function reads via `pairingFromCommandArg`. */
function toCommandArg(pairing: WorkspaceInventoryPairing): MateTreeNode {
  return { kind: "pairing", pairing, contextValue: "", description: "" };
}

interface PairingQuickPickItem extends vscode.QuickPickItem {
  pairing: WorkspaceInventoryPairing;
}

/** Passing an empty `items` array is deliberate: VS Code renders its native "no results" quick-pick state. */
async function pickPairing(
  pairings: readonly WorkspaceInventoryPairing[],
  placeHolder: string,
): Promise<WorkspaceInventoryPairing | undefined> {
  const items: PairingQuickPickItem[] = pairings.map((pairing) => ({
    label: pairing.repository.id,
    description: pairing.companionPath,
    pairing,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder });
  return picked?.pairing;
}

interface QuickPickActionDefinition {
  commandId: string;
  placeHolder: string;
  filter: (pairing: WorkspaceInventoryPairing, trusted: boolean) => boolean;
  run: (host: QuickPickActionsHost, arg: MateTreeNode) => void | Promise<void>;
}

const ACTIONS: QuickPickActionDefinition[] = [
  {
    commandId: "mate.quickOpenWorkspace",
    placeHolder: "Select a pairing to open as a workspace",
    filter: (pairing) => isPairingOpenable(pairing),
    run: (host, arg) => openWorkspace(host, arg),
  },
  {
    commandId: "mate.quickLaunchOpenCode",
    placeHolder: "Select a pairing to launch OpenCode against",
    filter: (pairing, trusted) => isPairingLaunchable(pairing, trusted),
    run: (host, arg) => launchAgent(host, "opencode", arg),
  },
  {
    commandId: "mate.quickLaunchClaude",
    placeHolder: "Select a pairing to launch Claude against",
    filter: (pairing, trusted) => isPairingLaunchable(pairing, trusted),
    run: (host, arg) => launchAgent(host, "claude", arg),
  },
  {
    commandId: "mate.quickRevealWorkingRepository",
    placeHolder: "Select a pairing to reveal its working repository",
    filter: (pairing) => isRepositoryRootAvailable(pairing),
    run: (_host, arg) => revealWorkingRepository(arg),
  },
  {
    commandId: "mate.quickRevealCompanion",
    placeHolder: "Select a pairing to reveal its companion",
    filter: () => true,
    run: (_host, arg) => revealCompanion(arg),
  },
  {
    commandId: "mate.quickCopyWorkingRepositoryPath",
    placeHolder: "Select a pairing to copy its working repository path",
    filter: (pairing) => isRepositoryRootAvailable(pairing),
    run: (_host, arg) => copyWorkingRepositoryPath(arg),
  },
  {
    commandId: "mate.quickCopyCompanionPath",
    placeHolder: "Select a pairing to copy its companion path",
    filter: () => true,
    run: (_host, arg) => copyCompanionPath(arg),
  },
];

/** Registers the Command Palette entries in {@link ACTIONS}, each delegating to `commands.ts`'s existing action functions. */
export function registerQuickPickCommands(
  context: vscode.ExtensionContext,
  host: QuickPickActionsHost,
): void {
  for (const action of ACTIONS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(action.commandId, async () => {
        const trusted = host.isTrusted();
        const eligible = pairingsFromState(host.getState()).filter((pairing) =>
          action.filter(pairing, trusted),
        );
        const pairing = await pickPairing(eligible, action.placeHolder);
        if (!pairing) return;
        await action.run(host, toCommandArg(pairing));
      }),
    );
  }
}
