import { afterEach, describe, expect, mock, test } from "bun:test";

import { createVscodeMock } from "./test-support/vscode-mock";

afterEach(() => {
  mock.restore();
});

async function loadProvider() {
  return import("./openspec-tree-provider");
}

describe("OpenSpecTreeProvider", () => {
  test("shows a loading placeholder before the first fetch resolves", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { OpenSpecTreeProvider } = await loadProvider();

    const provider = new OpenSpecTreeProvider(() => ({ status: "loading" }));

    const roots = provider.getChildren();
    expect(roots).toEqual([{ kind: "loading" }]);
    expect(provider.getTreeItem(roots[0]!).label).toContain("Loading");
  });

  test("shows an unavailable placeholder when openspec cannot be resolved", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { OpenSpecTreeProvider } = await loadProvider();

    const provider = new OpenSpecTreeProvider(() => ({ status: "unavailable" }));

    const item = provider.getTreeItem(provider.getChildren()[0]!);
    expect(item.contextValue).toBe("unavailable");
  });

  test("shows an empty placeholder when there are no companions at all", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { OpenSpecTreeProvider } = await loadProvider();

    const provider = new OpenSpecTreeProvider(() => ({ status: "ready", companions: [] }));

    const item = provider.getTreeItem(provider.getChildren()[0]!);
    expect(item.contextValue).toBe("empty");
  });

  test("root nodes are companion groups; children are that companion's changes", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { OpenSpecTreeProvider } = await loadProvider();
    const companions = [
      {
        companionPath: "/companions/a",
        changes: [{ name: "add-foo", completedTasks: 2, totalTasks: 5, status: "in-progress" }],
      },
    ];

    const provider = new OpenSpecTreeProvider(() => ({ status: "ready", companions }));

    const [root] = provider.getChildren();
    expect(provider.getTreeItem(root!).label).toBe("/companions/a");
    const [change] = provider.getChildren(root);
    const item = provider.getTreeItem(change!);
    expect(item.label).toBe("add-foo");
    expect(item.description).toBe("2/5 tasks");
    expect(provider.getChildren(change)).toEqual([]);
  });

  test("a companion with no active changes shows an empty child instead of nothing", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { OpenSpecTreeProvider } = await loadProvider();
    const companions = [{ companionPath: "/companions/a", changes: [] }];

    const provider = new OpenSpecTreeProvider(() => ({ status: "ready", companions }));

    const [root] = provider.getChildren();
    const [child] = provider.getChildren(root);
    expect(provider.getTreeItem(child!).contextValue).toBe("empty");
  });

  test("clicking a change item invokes the open-change command with its name and companion path", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { OpenSpecTreeProvider, OPEN_OPENSPEC_CHANGE_COMMAND } = await loadProvider();
    const companions = [
      {
        companionPath: "/companions/a",
        changes: [{ name: "add-foo", completedTasks: 2, totalTasks: 5, status: "in-progress" }],
      },
    ];

    const provider = new OpenSpecTreeProvider(() => ({ status: "ready", companions }));
    const [root] = provider.getChildren();
    const [change] = provider.getChildren(root);
    const item = provider.getTreeItem(change!);

    expect(item.command).toEqual({
      command: OPEN_OPENSPEC_CHANGE_COMMAND,
      title: "Open Change",
      arguments: [{ name: "add-foo", companionPath: "/companions/a" }],
    });
  });

  test("refresh() fires onDidChangeTreeData", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { OpenSpecTreeProvider } = await loadProvider();

    const provider = new OpenSpecTreeProvider(() => ({ status: "loading" }));
    let fired = 0;
    provider.onDidChangeTreeData(() => {
      fired += 1;
    });

    provider.refresh();

    expect(fired).toBe(1);
  });
});
