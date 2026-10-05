import { describe, expect, test } from "bun:test";

import type { StudioVaultSelection } from "../../selection";
import type { VaultFile, VaultManager, VaultTreeResult } from "../../vault";
import { vaultState } from "./state";

const selection: StudioVaultSelection = {
  companionDigest: null,
  view: "vault",
  refresh: false,
  openPath: null,
  openDir: null,
};

const listed: VaultTreeResult = {
  tree: [{ name: "note.md", path: "note.md", kind: "file" }],
  watching: true,
  warning: "watch unavailable",
};

function memoryVault(
  options: {
    prefetch?: () => Promise<VaultTreeResult | null>;
    tree?: () => Promise<VaultTreeResult>;
    open?: () => Promise<VaultFile>;
  } = {},
): VaultManager {
  return {
    prefetch: options.prefetch ?? (async () => listed),
    tree: options.tree ?? (async () => listed),
    open: options.open ?? (async () => ({ path: "note.md", content: "acme", token: "v1" })),
    save: async () => {
      throw new Error("unused");
    },
    subscribe: () => () => {},
    refresh: async () => listed,
    deactivate: () => {},
    stop: () => {},
    getRecovery: () => null,
  };
}

describe("vaultState", () => {
  test("includes an already collected tree and its watch status", async () => {
    expect(
      await vaultState(memoryVault(), "/companions/acme", selection, { tree: "prefetch" }),
    ).toEqual({
      tree: listed.tree,
      open: null,
      refusal: null,
      incoming: null,
      overwritten: null,
      watching: true,
      warning: "watch unavailable",
      failure: null,
    });
  });

  test("leaves the tree pending without waiting for a listing", async () => {
    const state = await vaultState(
      memoryVault({ prefetch: async () => null }),
      "/companions/acme",
      selection,
      { tree: "prefetch" },
    );
    expect(state).toMatchObject({ tree: null, watching: false, warning: null, failure: null });
  });

  test("opens a file while the tree is pending", async () => {
    const state = await vaultState(
      memoryVault({ prefetch: async () => null }),
      "/companions/acme",
      { ...selection, openPath: "note.md" },
      { tree: "prefetch" },
    );
    expect(state.open).toEqual({ path: "note.md", content: "acme", token: "v1" });
    expect(state.tree).toBeNull();
  });

  test("reports a refused open separately from the tree", async () => {
    const state = await vaultState(
      memoryVault({
        open: async () => {
          throw new Error("path refused");
        },
      }),
      "/companions/acme",
      { ...selection, openPath: "nope.md" },
      { tree: "await" },
    );
    expect(state).toMatchObject({
      tree: listed.tree,
      open: null,
      refusal: "path refused",
      failure: null,
    });
  });

  test.each(["prefetch", "await"] as const)("reports %s listing failure in place", async (mode) => {
    const failed = async (): Promise<VaultTreeResult> => {
      throw new Error("listing failed");
    };
    const state = await vaultState(
      memoryVault({ prefetch: failed, tree: failed }),
      "/companions/acme",
      selection,
      { tree: mode },
    );
    expect(state).toMatchObject({
      tree: null,
      watching: false,
      warning: null,
      failure: "listing failed",
    });
  });

  test("uses the selected refresh on the awaited tree", async () => {
    const refreshes: boolean[] = [];
    const manager = memoryVault({ tree: async () => listed });
    manager.tree = async (_root, refresh) => {
      refreshes.push(refresh ?? false);
      return listed;
    };
    await vaultState(
      manager,
      "/companions/acme",
      { ...selection, refresh: true },
      { tree: "await" },
    );
    expect(refreshes).toEqual([true]);
  });
});
