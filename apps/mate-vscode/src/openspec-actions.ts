import * as vscode from "vscode";

import { OPEN_OPENSPEC_CHANGE_COMMAND } from "./openspec-tree-provider";
import type { OpenSpecService } from "./openspec-service";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface OpenChangeArg {
  name: string;
  companionPath: string;
}

function isOpenChangeArg(value: unknown): value is OpenChangeArg {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OpenChangeArg).name === "string" &&
    typeof (value as OpenChangeArg).companionPath === "string"
  );
}

/** Opens a change's proposal.md; falls back to revealing its folder when no proposal exists (e.g. a non-spec-driven schema). */
export async function openOpenSpecChange(
  openSpecService: OpenSpecService,
  arg: OpenChangeArg,
): Promise<void> {
  let changeRoot: string;
  try {
    changeRoot = await openSpecService.getChangeRoot(arg.name, arg.companionPath);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Mate: could not open change "${arg.name}" — ${describeError(error)}`,
    );
    return;
  }

  try {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(`${changeRoot}/proposal.md`),
    );
    await vscode.window.showTextDocument(document);
  } catch {
    void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(changeRoot));
  }
}

export function registerOpenSpecCommands(
  context: vscode.ExtensionContext,
  openSpecService: OpenSpecService,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_OPENSPEC_CHANGE_COMMAND, (arg: unknown) =>
      isOpenChangeArg(arg) ? openOpenSpecChange(openSpecService, arg) : undefined,
    ),
  );
}
