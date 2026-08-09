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

async function openWorkspace(host: CommandsHost, arg: unknown): Promise<void> {
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

function revealWorkingRepository(arg: unknown): void {
  const pairing = pairingFromCommandArg(arg);
  if (!pairing || pairing.health !== "ready") return;
  void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(pairing.repository.path));
}

function revealCompanion(arg: unknown): void {
  const pairing = pairingFromCommandArg(arg);
  if (!pairing) return;
  void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(pairing.companionPath));
}

function copyWorkingRepositoryPath(arg: unknown): void {
  const pairing = pairingFromCommandArg(arg);
  if (!pairing || pairing.health !== "ready") return;
  void vscode.env.clipboard.writeText(pairing.repository.path);
}

function copyCompanionPath(arg: unknown): void {
  const pairing = pairingFromCommandArg(arg);
  if (!pairing) return;
  void vscode.env.clipboard.writeText(pairing.companionPath);
}

function launchAgent(host: CommandsHost, agent: SupportedAgent, arg: unknown): void {
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
  );
}
