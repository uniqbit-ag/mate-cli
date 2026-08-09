import { afterEach, describe, expect, mock, test } from "bun:test";

import { buildPairingSnapshot } from "./pairing-snapshot";
import type { WorkspaceInventoryV1 } from "./schema";
import { createVscodeMock } from "./test-support/vscode-mock";

afterEach(() => {
  mock.restore();
});

const INVENTORY: WorkspaceInventoryV1 = {
  schemaVersion: 1,
  companions: [{ path: "/companions/a", health: "ready" }],
  pairings: [
    {
      companionPath: "/companions/a",
      repository: { id: "app", path: "/repos/app" },
      health: "ready",
      ambiguous: false,
    },
  ],
};

async function loadProviders() {
  return import("./tree-providers");
}

describe("WorkingRepositoryTreeProvider", () => {
  test("shows a loading placeholder before the first fetch resolves", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { WorkingRepositoryTreeProvider } = await loadProviders();

    const provider = new WorkingRepositoryTreeProvider({
      getState: () => ({ status: "loading" }),
      isTrusted: () => true,
    });

    const roots = provider.getChildren();
    expect(roots).toEqual([{ kind: "loading" }]);
    expect(provider.getTreeItem(roots[0]!).label).toContain("Loading");
  });

  test("shows an unavailable placeholder when mate cannot be spawned", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { WorkingRepositoryTreeProvider } = await loadProviders();

    const provider = new WorkingRepositoryTreeProvider({
      getState: () => ({ status: "unavailable" }),
      isTrusted: () => true,
    });

    const item = provider.getTreeItem(provider.getChildren()[0]!);
    expect(item.contextValue).toBe("unavailable");
  });

  test("root nodes are working repositories; children are per-companion pairings", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { WorkingRepositoryTreeProvider } = await loadProviders();
    const snapshot = buildPairingSnapshot(INVENTORY);

    const provider = new WorkingRepositoryTreeProvider({
      getState: () => ({ status: "ready", snapshot }),
      isTrusted: () => true,
    });

    const [root] = provider.getChildren();
    expect(provider.getTreeItem(root!).label).toBe("app");
    const children = provider.getChildren(root);
    expect(children).toHaveLength(1);
    const pairingItem = provider.getTreeItem(children[0]!);
    expect(pairingItem.contextValue).toContain("pairing-open");
    expect(pairingItem.command.command).toBe("mate.openWorkspace");
    expect(pairingItem.command.arguments).toEqual([children[0]]);
    expect((pairingItem.command.arguments[0] as { pairing: unknown }).pairing).toEqual(
      INVENTORY.pairings[0],
    );
  });

  test("refresh() fires onDidChangeTreeData", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { WorkingRepositoryTreeProvider } = await loadProviders();

    const provider = new WorkingRepositoryTreeProvider({
      getState: () => ({ status: "loading" }),
      isTrusted: () => true,
    });
    let fired = 0;
    provider.onDidChangeTreeData(() => {
      fired += 1;
    });

    provider.refresh();

    expect(fired).toBe(1);
  });
});

describe("CompanionTreeProvider", () => {
  test("root nodes are companions; children are per-repository pairings", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { CompanionTreeProvider } = await loadProviders();
    const snapshot = buildPairingSnapshot(INVENTORY);

    const provider = new CompanionTreeProvider({
      getState: () => ({ status: "ready", snapshot }),
      isTrusted: () => true,
    });

    const [root] = provider.getChildren();
    expect(provider.getTreeItem(root!).label).toBe("/companions/a");
    const children = provider.getChildren(root);
    expect(children).toHaveLength(1);
  });

  test("an untrusted window still shows pairings but without launchable context", async () => {
    const { module } = createVscodeMock();
    mock.module("vscode", () => module);
    const { CompanionTreeProvider } = await loadProviders();
    const snapshot = buildPairingSnapshot(INVENTORY);

    const provider = new CompanionTreeProvider({
      getState: () => ({ status: "ready", snapshot }),
      isTrusted: () => false,
    });

    const [root] = provider.getChildren();
    const [pairing] = provider.getChildren(root);
    const item = provider.getTreeItem(pairing!);
    expect(item.contextValue).not.toContain("pairing-launchable");
  });
});
