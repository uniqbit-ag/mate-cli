import * as vscode from "vscode";

import {
  buildCompanionRoots,
  buildWorkingRepositoryRoots,
  childrenOfCompanionGroup,
  childrenOfWorkingRepository,
  isPairingOpenable,
  type MateTreeNode,
  type MateViewState,
  rootNodesForState,
} from "./tree-model";
import type { WorkspaceInventoryPairing } from "./schema";

export interface TreeContext {
  getState: () => MateViewState;
  isTrusted: () => boolean;
}

function healthIcon(health: string): vscode.ThemeIcon {
  if (health === "ready")
    return new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
  if (health === "unreadable")
    return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
  return new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
}

function pairingTooltip(pairing: WorkspaceInventoryPairing): string {
  const lines = [
    `Companion: ${pairing.companionPath}`,
    `Repository: ${pairing.repository.id} (${pairing.repository.path})`,
    `Health: ${pairing.health}`,
  ];
  if (pairing.ambiguous)
    lines.push("This working repository is linked from more than one companion.");
  if (pairing.diagnostic) lines.push(pairing.diagnostic);
  return lines.join("\n");
}

function toTreeItem(node: MateTreeNode): vscode.TreeItem {
  switch (node.kind) {
    case "loading": {
      const item = new vscode.TreeItem("Loading Mate workspaces…");
      item.contextValue = "loading";
      return item;
    }
    case "empty": {
      const item = new vscode.TreeItem("No companions registered.");
      item.contextValue = "empty";
      item.tooltip = "Run `mate companion link` from a working repository, then refresh.";
      return item;
    }
    case "unavailable": {
      const item = new vscode.TreeItem("Mate CLI not found.");
      item.contextValue = "unavailable";
      item.tooltip = "Install Mate and, if it's not on PATH, set the mate.executablePath setting.";
      item.iconPath = new vscode.ThemeIcon("error");
      return item;
    }
    case "error": {
      const item = new vscode.TreeItem(`Mate error: ${node.message}`);
      item.contextValue = "error";
      item.tooltip = node.message;
      item.iconPath = new vscode.ThemeIcon("error");
      return item;
    }
    case "working-repository": {
      const item = new vscode.TreeItem(node.repositoryId, vscode.TreeItemCollapsibleState.Expanded);
      item.description = node.repositoryPath;
      item.tooltip = node.repositoryPath;
      item.contextValue = "working-repository";
      return item;
    }
    case "companion-group": {
      const item = new vscode.TreeItem(
        node.companionPath,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = "companion-group";
      item.iconPath = healthIcon(node.companionHealth);
      item.tooltip = node.companionDiagnostic ?? node.companionPath;
      return item;
    }
    case "pairing": {
      const item = new vscode.TreeItem(node.description, vscode.TreeItemCollapsibleState.None);
      item.contextValue = node.contextValue;
      item.iconPath = healthIcon(node.pairing.health);
      item.tooltip = pairingTooltip(node.pairing);
      if (isPairingOpenable(node.pairing)) {
        item.command = {
          command: "mate.openWorkspace",
          title: "Open Workspace",
          arguments: [node],
        };
      }
      return item;
    }
  }
}

abstract class MateTreeDataProvider implements vscode.TreeDataProvider<MateTreeNode> {
  private readonly emitter = new vscode.EventEmitter<MateTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(protected readonly context: TreeContext) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: MateTreeNode): vscode.TreeItem {
    return toTreeItem(element);
  }

  abstract grouping: "working-repository" | "companion";
  abstract childrenOf(node: MateTreeNode): MateTreeNode[];

  getChildren(element?: MateTreeNode): MateTreeNode[] {
    if (!element) return rootNodesForState(this.context.getState(), this.grouping);
    return this.childrenOf(element);
  }
}

export class WorkingRepositoryTreeProvider extends MateTreeDataProvider {
  readonly grouping = "working-repository" as const;

  childrenOf(node: MateTreeNode): MateTreeNode[] {
    return node.kind === "working-repository"
      ? childrenOfWorkingRepository(node, this.context.isTrusted())
      : [];
  }
}

export class CompanionTreeProvider extends MateTreeDataProvider {
  readonly grouping = "companion" as const;

  childrenOf(node: MateTreeNode): MateTreeNode[] {
    return node.kind === "companion-group"
      ? childrenOfCompanionGroup(node, this.context.isTrusted())
      : [];
  }
}

// Re-exported so callers building an initial "ready" state don't need a
// separate import just to construct root nodes outside a provider (e.g. tests).
export { buildCompanionRoots, buildWorkingRepositoryRoots };
