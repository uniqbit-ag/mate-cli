import * as vscode from "vscode";

/** One sidebar section: loads its items on refresh and shows a failure as a single item. */

export interface SectionItem {
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  contextValue?: string;
  command?: vscode.Command;
  /** Payload for item commands. */
  data?: unknown;
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
    const tree = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
    tree.description = item.description;
    tree.tooltip = item.tooltip;
    tree.contextValue = item.contextValue;
    tree.command = item.command;
    if (item.icon) tree.iconPath = new vscode.ThemeIcon(item.icon);
    return tree;
  }

  async getChildren(): Promise<SectionItem[]> {
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
        { label: (error as Error).message, icon: "error", tooltip: (error as Error).message },
      ];
    }
  }

  dispose(): void {
    this.view.dispose();
    this.changed.dispose();
  }
}
