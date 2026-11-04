import { VAULT_TREE_STORAGE_KEY } from "../shell/prepaint";
import { create } from "zustand";

interface VaultUiState {
  /** Hidden by the viewer; remembered like the server-rendered vault remembered it. */
  treeHidden: boolean;
  /** The newest listing generation the watch reported; newer than the shown tree means stale. */
  latestGeneration: number | null;
  /** The editor holds text that differs from what was opened or last saved. */
  dirty: boolean;
  hydrate(): void;
  toggleTree(): void;
  setGeneration(generation: number): void;
  setDirty(dirty: boolean): void;
}

export const useVaultUi = create<VaultUiState>((set, get) => ({
  treeHidden: false,
  latestGeneration: null,
  dirty: false,
  hydrate: () =>
    set({ treeHidden: document.documentElement.getAttribute("data-vault-tree") === "hidden" }),
  toggleTree: () => {
    const treeHidden = !get().treeHidden;
    if (treeHidden) document.documentElement.setAttribute("data-vault-tree", "hidden");
    else document.documentElement.removeAttribute("data-vault-tree");
    try {
      localStorage.setItem(VAULT_TREE_STORAGE_KEY, treeHidden ? "hidden" : "shown");
    } catch {
      /* a blocked web store only costs the preference */
    }
    set({ treeHidden });
  },
  setGeneration: (generation) =>
    set((state) => ({
      latestGeneration: Math.max(generation, state.latestGeneration ?? generation),
    })),
  setDirty: (dirty) => set({ dirty }),
}));
