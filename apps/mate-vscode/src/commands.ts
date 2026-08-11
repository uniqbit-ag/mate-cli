import * as vscode from "vscode";

import { pairingFromCommandArg } from "./command-args";
import type { WorkspaceInventoryPairing } from "./schema";
import { buildTerminalLaunchPlan, type SupportedAgent } from "./terminal-launch";
import { isPairingLaunchable, isPairingOpenable } from "./tree-model";
import type { WorkspaceService } from "./workspace-service";

export interface CommandsHost {
  workspaceService: WorkspaceService;
  refresh: () => Promise<void>;
  isTrusted: () => boolean;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requirePairing(arg: unknown, action: string): WorkspaceInventoryPairing | undefined {
  const pairing = pairingFromCommandArg(arg);
  if (!pairing) {
    void vscode.window.showErrorMessage(
      `Mate: ${action} requires selecting a pairing in the Workspaces or Companions view.`,
    );
  }
  return pairing;
}

/**
 * Underlying action functions, exported so the quick-pick palette selector
 * ({@link ./quick-pick-actions}) delegates to the exact same behavior as
 * the tree-context-menu commands instead of duplicating pairing-capability
 * logic.
 */

export async function openWorkspace(host: CommandsHost, arg: unknown): Promise<void> {
  const pairing = requirePairing(arg, "Open Workspace");
  if (!pairing || !isPairingOpenable(pairing)) return;

  try {
    const result = await host.workspaceService.materialize({
      repositoryId: pairing.repository.id,
      companionPath: pairing.companionPath,
    });
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(result.workspacePath),
      {
        forceNewWindow: true,
      },
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`Mate: could not open workspace — ${describeError(error)}`);
  }
}

export function revealWorkingRepository(arg: unknown): void {
  const pairing = pairingFromCommandArg(arg);
  if (!pairing || pairing.health !== "ready") return;
  void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(pairing.repository.path));
}

export function revealCompanion(arg: unknown): void {
  const pairing = pairingFromCommandArg(arg);
  if (!pairing) return;
  void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(pairing.companionPath));
}

export function copyWorkingRepositoryPath(arg: unknown): void {
  const pairing = pairingFromCommandArg(arg);
  if (!pairing || pairing.health !== "ready") return;
  void vscode.env.clipboard.writeText(pairing.repository.path);
}

export function copyCompanionPath(arg: unknown): void {
  const pairing = pairingFromCommandArg(arg);
  if (!pairing) return;
  void vscode.env.clipboard.writeText(pairing.companionPath);
}

export function launchAgent(host: CommandsHost, agent: SupportedAgent, arg: unknown): void {
  const pairing = requirePairing(arg, `Launch ${agent === "opencode" ? "OpenCode" : "Claude"}`);
  if (!pairing) return;

  const trusted = host.isTrusted();
  if (!isPairingLaunchable(pairing, trusted)) {
    void vscode.window.showErrorMessage(
      trusted
        ? "Mate: this pairing is unhealthy and cannot launch an agent."
        : "Mate: agent launches are disabled in an untrusted workspace.",
    );
    return;
  }

  const plan = buildTerminalLaunchPlan(agent, {
    repositoryId: pairing.repository.id,
    repositoryPath: pairing.repository.path,
    companionPath: pairing.companionPath,
  });
  const terminal = vscode.window.createTerminal({ name: plan.name, cwd: plan.cwd, env: plan.env });
  terminal.show();
  terminal.sendText(plan.commandLine);
}

/**
 * Appends the companion as a second workspace-folder root in the *current*
 * window — an alternative to `mate.openWorkspace`'s new-window materialize,
 * never persisting a `.code-workspace` file itself.
 */
export function attachCompanionToWorkspace(arg: unknown): void {
  const pairing = requirePairing(arg, "Attach Companion to Workspace");
  if (!pairing) return;

  const folders = vscode.workspace.workspaceFolders ?? [];
  const companionUri = vscode.Uri.file(pairing.companionPath);
  if (folders.some((folder) => folder.uri.fsPath === companionUri.fsPath)) {
    void vscode.window.showInformationMessage(
      `Mate: ${pairing.companionPath} is already attached to this workspace.`,
    );
    return;
  }

  const becomesMultiRoot = folders.length <= 1;
  vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: companionUri });
  void vscode.window.showInformationMessage(
    becomesMultiRoot
      ? "Mate: companion attached — this workspace is now unsaved; VS Code will prompt to save it as a workspace file if you want to keep it."
      : "Mate: companion attached to the current workspace.",
  );
}

/** Registers every `mate.*` command declared in package.json's contributes.commands. */
export function registerCommands(context: vscode.ExtensionContext, host: CommandsHost): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("mate.refreshWorkspaces", () => host.refresh()),
    vscode.commands.registerCommand("mate.openWorkspace", (arg: unknown) =>
      openWorkspace(host, arg),
    ),
    vscode.commands.registerCommand("mate.revealWorkingRepository", revealWorkingRepository),
    vscode.commands.registerCommand("mate.revealCompanion", revealCompanion),
    vscode.commands.registerCommand("mate.copyWorkingRepositoryPath", copyWorkingRepositoryPath),
    vscode.commands.registerCommand("mate.copyCompanionPath", copyCompanionPath),
    vscode.commands.registerCommand("mate.launchOpenCode", (arg: unknown) =>
      launchAgent(host, "opencode", arg),
    ),
    vscode.commands.registerCommand("mate.launchClaude", (arg: unknown) =>
      launchAgent(host, "claude", arg),
    ),
    vscode.commands.registerCommand("mate.attachCompanionToWorkspace", attachCompanionToWorkspace),
  );
}
