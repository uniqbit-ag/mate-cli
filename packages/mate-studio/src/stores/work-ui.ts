import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** A confirmation open on one Workset; held here so a live refetch never closes it. */
export interface WorkDialog {
  kind: "share" | "claim" | "release" | "start-manual";
  workset: string;
}

interface WorkUiState {
  /** Unsaved Scratchpad text by companion digest; kept for this tab across refetches and reloads. */
  drafts: Record<string, string>;
  setDraft(companion: string, text: string): void;
  dialog: WorkDialog | null;
  open(dialog: WorkDialog): void;
  close(): void;
  /** Expanded multi-change cards. */
  expanded: Record<string, boolean>;
  toggle(workset: string): void;
}

export const useWorkUi = create<WorkUiState>()(
  persist(
    (set) => ({
      drafts: {},
      setDraft: (companion, text) =>
        set((state) => ({ drafts: { ...state.drafts, [companion]: text } })),
      dialog: null,
      open: (dialog) => set({ dialog }),
      close: () => set({ dialog: null }),
      expanded: {},
      toggle: (workset) =>
        set((state) => ({ expanded: { ...state.expanded, [workset]: !state.expanded[workset] } })),
    }),
    {
      name: "mate.work.drafts",
      storage: createJSONStorage(() => sessionStorage),
      partialize: ({ drafts }) => ({ drafts }),
    },
  ),
);
