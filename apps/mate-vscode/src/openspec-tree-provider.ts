import * as vscode from "vscode";

import {
  childrenOfOpenSpecCompanionGroup,
  type OpenSpecTreeNode,
  type OpenSpecViewState,
  rootNodesForOpenSpecState,
} from "./openspec-tree-model";

export const OPEN_OPENSPEC_CHANGE_COMMAND = "mate.openOpenSpecChange";

function toTreeItem(node: OpenSpecTreeNode): vscode.TreeItem {
  switch (node.kind) {
    case "loading": {
      const item = new vscode.TreeItem("Loading OpenSpec changes…");
      item.contextValue = "loading";
      return item;
    }
    case "empty": {
      const item = new vscode.TreeItem("No active OpenSpec changes.");
      item.contextValue = "empty";
      return item;
    }
    case "unavailable": {
      const item = new vscode.TreeItem("openspec CLI not found.");
      item.contextValue = "unavailable";
      item.tooltip =
        "Install openspec and, if it's not on PATH, set the mate.openspecExecutablePath setting.";
      item.iconPath = new vscode.ThemeIcon("error");
      return item;
    }
    case "error": {
      const item = new vscode.TreeItem(`openspec error: ${node.message}`);
      item.contextValue = "error";
      item.tooltip = node.message;
      item.iconPath = new vscode.ThemeIcon("error");
      return item;
    }
    case "companion-group": {
      const item = new vscode.TreeItem(
        node.companionPath,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = "openspec-companion-group";
      return item;
    }
    case "change": {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
      item.description = `${node.completedTasks}/${node.totalTasks} tasks`;
      item.tooltip = `${node.name} — ${node.status} (${node.completedTasks}/${node.totalTasks} tasks complete)`;
      item.contextValue = "openspec-change";
      item.iconPath =
        node.totalTasks > 0 && node.completedTasks === node.totalTasks
          ? new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"))
          : new vscode.ThemeIcon("circle-large-outline");
      item.command = {
        command: OPEN_OPENSPEC_CHANGE_COMMAND,
        title: "Open Change",
        arguments: [{ name: node.name, companionPath: node.companionPath }],
      };
      return item;
    }
  }
}

/** Read-only tree view over `openspec list --json` — surfaces change/task progress, never mutates a change or spec. */
export class OpenSpecTreeProvider implements vscode.TreeDataProvider<OpenSpecTreeNode> {
  private readonly emitter = new vscode.EventEmitter<OpenSpecTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly getState: () => OpenSpecViewState) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: OpenSpecTreeNode): vscode.TreeItem {
    return toTreeItem(element);
  }

  getChildren(element?: OpenSpecTreeNode): OpenSpecTreeNode[] {
    if (!element) return rootNodesForOpenSpecState(this.getState());
    return element.kind === "companion-group" ? childrenOfOpenSpecCompanionGroup(element) : [];
  }
}
