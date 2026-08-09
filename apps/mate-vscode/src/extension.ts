import * as vscode from "vscode";

import { registerCommands } from "./commands";
import { buildPairingSnapshot } from "./pairing-snapshot";
import type { MateViewState } from "./tree-model";
import { CompanionTreeProvider, WorkingRepositoryTreeProvider } from "./tree-providers";
import { WorkspaceService } from "./workspace-service";

export interface ActivateOverrides {
  /** Test seam: injects a fake WorkspaceService instead of spawning the real `mate` executable. */
  workspaceService?: WorkspaceService;
}

function isTrusted(): boolean {
  return vscode.workspace.isTrusted;
}

export function activate(
  context: vscode.ExtensionContext,
  overrides: ActivateOverrides = {},
): void {
  let state: MateViewState = { status: "loading" };

  const workspaceService =
    overrides.workspaceService ??
    new WorkspaceService(() => ({
      executablePath: vscode.workspace.getConfiguration("mate").get<string>("executablePath"),
    }));

  const workingRepositoryProvider = new WorkingRepositoryTreeProvider({
    getState: () => state,
    isTrusted,
  });
  const companionProvider = new CompanionTreeProvider({ getState: () => state, isTrusted });

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("mateWorkspaces", workingRepositoryProvider),
    vscode.window.registerTreeDataProvider("mateCompanions", companionProvider),
  );

  const renderState = (): void => {
    workingRepositoryProvider.refresh();
    companionProvider.refresh();
  };

  const refresh = async (): Promise<void> => {
    state = { status: "loading" };
    renderState();
    try {
      const available = await workspaceService.isMateAvailable();
      if (!available) {
        state = { status: "unavailable" };
        return;
      }
      const inventory = await workspaceService.fetchInventory();
      state = { status: "ready", snapshot: buildPairingSnapshot(inventory) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state = { status: "error", message };
      void vscode.window.showErrorMessage(`Mate: could not load workspace inventory — ${message}`);
    } finally {
      renderState();
    }
  };

  registerCommands(context, { workspaceService, refresh, isTrusted });

  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(renderState));

  void refresh();
}

export function deactivate(): void {}
