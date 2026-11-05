import * as vscode from "vscode";

import { ICONS, type Icon } from "./icons";

/** One sidebar section: loads its items on refresh and shows a failure as a single item. */

export interface SectionItem {
  id?: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: Icon;
  contextValue?: string;
  command?: vscode.Command;
  /** Payload for item commands. */
  data?: unknown;
  /** Child items; the item shows as a group. */
  children?: SectionItem[];
  collapsed?: boolean;
}

export type SectionLoad = { message: string } | { items: SectionItem[] };

export class Section implements vscode.TreeDataProvider<SectionItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<SectionItem>;

  constructor(
    id: string,
    private readonly load: () => Promise<SectionLoad>,
  ) {
    this.view = vscode.window.createTreeView(id, { treeDataProvider: this });
    this.view.onDidChangeVisibility((event) => {
      if (event.visible) this.refresh();
    });
  }

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: SectionItem): vscode.TreeItem {
    const state = !item.children
      ? vscode.TreeItemCollapsibleState.None
      : item.collapsed
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded;
    const tree = new vscode.TreeItem(item.label, state);
    tree.id = item.id;
    tree.description = item.description;
    tree.tooltip = item.tooltip;
    tree.contextValue = item.contextValue;
    tree.command = item.command;
    if (item.icon) {
      const color = item.icon.color ? new vscode.ThemeColor(item.icon.color) : undefined;
      tree.iconPath = new vscode.ThemeIcon(item.icon.id, color);
    }
    return tree;
  }

  async getChildren(element?: SectionItem): Promise<SectionItem[]> {
    if (element) return element.children ?? [];
    try {
      const result = await this.load();
      if ("message" in result) {
        this.view.message = result.message;
        return [];
      }
      this.view.message = undefined;
      return result.items;
    } catch (error) {
      this.view.message = undefined;
      return [
        { label: (error as Error).message, icon: ICONS.error, tooltip: (error as Error).message },
      ];
    }
  }

  dispose(): void {
    this.view.dispose();
    this.changed.dispose();
  }
}
