import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface FactoryUiState {
  /** The board filter; kept for this tab, like the server-rendered board kept it across reloads. */
  filter: string;
  setFilter(filter: string): void;
  /** Whether the open dialog was reached by stepping (J/K); its terminal then leaves focus alone. */
  stepped: boolean;
  setStepped(stepped: boolean): void;
  /** Whether the Agents panel is open; a run refused for a missing credential opens it. */
  agentsOpen: boolean;
  setAgentsOpen(open: boolean): void;
  /** Whether the Git access panel is open. */
  gitAccessOpen: boolean;
  setGitAccessOpen(open: boolean): void;
}

export const useFactoryUi = create<FactoryUiState>()(
  persist(
    (set) => ({
      filter: "",
      setFilter: (filter) => set({ filter }),
      stepped: false,
      setStepped: (stepped) => set({ stepped }),
      agentsOpen: false,
      setAgentsOpen: (agentsOpen) => set({ agentsOpen }),
      gitAccessOpen: false,
      setGitAccessOpen: (gitAccessOpen) => set({ gitAccessOpen }),
    }),
    {
      name: "mate.factory.filter",
      storage: createJSONStorage(() => sessionStorage),
      partialize: ({ filter }) => ({ filter }),
    },
  ),
);
