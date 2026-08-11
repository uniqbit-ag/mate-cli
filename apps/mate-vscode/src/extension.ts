import * as vscode from "vscode";

import { registerCommands } from "./commands";
import { DoctorDiagnostics } from "./doctor-diagnostics";
import { runMateCli } from "./mate-cli-client";
import { registerOpenSpecCommands } from "./openspec-actions";
import { OpenSpecService } from "./openspec-service";
import type { OpenSpecCompanionChanges, OpenSpecViewState } from "./openspec-tree-model";
import { OpenSpecTreeProvider } from "./openspec-tree-provider";
import { buildPairingSnapshot } from "./pairing-snapshot";
import { registerQuickPickCommands } from "./quick-pick-actions";
import type { WorkspaceInventoryPairing } from "./schema";
import { MateStatusBarItem, REVEAL_STATUS_BAR_PAIRING_COMMAND } from "./status-bar";
import {
  buildWorkingRepositoryRoots,
  childrenOfWorkingRepository,
  type MateViewState,
} from "./tree-model";
import { CompanionTreeProvider, WorkingRepositoryTreeProvider } from "./tree-providers";
import { WorkspaceService } from "./workspace-service";

export interface ActivateOverrides {
  /** Test seam: injects a fake WorkspaceService instead of spawning the real `mate` executable. */
  workspaceService?: WorkspaceService;
  /** Test seam: injects a fake OpenSpecService instead of spawning the real `openspec` executable. */
  openSpecService?: OpenSpecService;
  /** Test seam: injects a fake DoctorDiagnostics instead of spawning the real `mate doctor` command. */
  doctorDiagnostics?: DoctorDiagnostics;
}

function isTrusted(): boolean {
  return vscode.workspace.isTrusted;
}

function workspaceFolderPaths(): readonly string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

export function activate(
  context: vscode.ExtensionContext,
  overrides: ActivateOverrides = {},
): void {
  let state: MateViewState = { status: "loading" };
  let openSpecState: OpenSpecViewState = { status: "loading" };

  const workspaceService =
    overrides.workspaceService ??
    new WorkspaceService(() => ({
      executablePath: vscode.workspace.getConfiguration("mate").get<string>("executablePath"),
    }));
  const openSpecService =
    overrides.openSpecService ??
    new OpenSpecService(() => ({
      executablePath: vscode.workspace
        .getConfiguration("mate")
        .get<string>("openspecExecutablePath"),
    }));
  const doctorDiagnostics =
    overrides.doctorDiagnostics ??
    new DoctorDiagnostics({
      runMateCli,
      options: () => ({
        executablePath: vscode.workspace.getConfiguration("mate").get<string>("executablePath"),
      }),
    });

  const workingRepositoryProvider = new WorkingRepositoryTreeProvider({
    getState: () => state,
    isTrusted,
  });
  const companionProvider = new CompanionTreeProvider({ getState: () => state, isTrusted });
  const openSpecProvider = new OpenSpecTreeProvider(() => openSpecState);

  const workspacesTreeView = vscode.window.createTreeView("mateWorkspaces", {
    treeDataProvider: workingRepositoryProvider,
  });
  context.subscriptions.push(
    workspacesTreeView,
    vscode.window.registerTreeDataProvider("mateCompanions", companionProvider),
    vscode.window.registerTreeDataProvider("mateActiveChanges", openSpecProvider),
  );

  /** Reveals the pairing's leaf tree item in the Workspaces view — the only lookup the status bar needs. */
  function revealPairing(pairing: WorkspaceInventoryPairing): void {
    if (state.status !== "ready") return;
    const root = buildWorkingRepositoryRoots(state.snapshot).find(
      (node) => node.kind === "working-repository" && node.repositoryId === pairing.repository.id,
    );
    if (!root || root.kind !== "working-repository") return;
    const node = childrenOfWorkingRepository(root, isTrusted()).find(
      (candidate) =>
        candidate.kind === "pairing" && candidate.pairing.companionPath === pairing.companionPath,
    );
    if (node) void workspacesTreeView.reveal(node, { select: true, focus: true, expand: true });
  }

  const statusBar = new MateStatusBarItem({
    getState: () => state,
    getWorkspaceFolderPaths: workspaceFolderPaths,
    revealPairing,
  });
  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand(REVEAL_STATUS_BAR_PAIRING_COMMAND, () =>
      statusBar.handleClick(),
    ),
  );
  doctorDiagnostics.register(context);
  context.subscriptions.push(doctorDiagnostics);

  const renderState = (): void => {
    workingRepositoryProvider.refresh();
    companionProvider.refresh();
    statusBar.render();
  };

  const refreshWorkspaces = async (): Promise<void> => {
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

  /** One `openspec list --json` call per companion, grouped in the tree the same way Workspaces/Companions group pairings. */
  const refreshOpenSpec = async (): Promise<void> => {
    openSpecState = { status: "loading" };
    openSpecProvider.refresh();
    try {
      const available = await openSpecService.isOpenSpecAvailable();
      if (!available) {
        openSpecState = { status: "unavailable" };
        return;
      }
      const companionPaths =
        state.status === "ready" ? state.snapshot.companions.map((c) => c.path) : [];
      const companions: OpenSpecCompanionChanges[] = await Promise.all(
        companionPaths.map(async (companionPath) => {
          try {
            return { companionPath, changes: await openSpecService.listChanges(companionPath) };
          } catch {
            // A companion with no openspec/ root (or an unresolvable one) shows
            // as empty, not an error — one bad companion shouldn't blank the view.
            return { companionPath, changes: [] };
          }
        }),
      );
      openSpecState = { status: "ready", companions };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      openSpecState = { status: "error", message };
      void vscode.window.showErrorMessage(`Mate: could not load OpenSpec changes — ${message}`);
    } finally {
      openSpecProvider.refresh();
    }
  };

  const refreshAll = async (): Promise<void> => {
    // refreshWorkspaces populates `state.snapshot.companions`, which
    // refreshOpenSpec needs to know which companions to query — must
    // resolve before OpenSpec/doctor run.
    await refreshWorkspaces();
    await Promise.all([refreshOpenSpec(), doctorDiagnostics.refresh()]);
  };

  registerCommands(context, { workspaceService, refresh: refreshAll, isTrusted });
  registerQuickPickCommands(context, {
    workspaceService,
    refresh: refreshAll,
    isTrusted,
    getState: () => state,
  });
  registerOpenSpecCommands(context, openSpecService);

  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(renderState));

  void refreshAll();
}

export function deactivate(): void {}
