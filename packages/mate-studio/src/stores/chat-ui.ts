import {
  CHAT_EFFORTS,
  CHAT_MODELS,
  type ChatEffort,
  type ChatModel,
  chatModel,
} from "@uniqbit/mate-core/studio";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface ChatUiState {
  /** The model the next question runs on; remembered across visits. */
  model: ChatModel;
  /** How hard it thinks; a model that takes no effort runs without it. */
  effort: ChatEffort;
  /** Whether the session panel beside the conversation is open. */
  panelOpen: boolean;
  /** Whether the chat credential sheet is open; never remembered. */
  credentialOpen: boolean;
  setModel(model: ChatModel): void;
  setEffort(effort: ChatEffort): void;
  setPanelOpen(open: boolean): void;
  setCredentialOpen(open: boolean): void;
}

export const useChatUi = create<ChatUiState>()(
  persist(
    (set) => ({
      model: CHAT_MODELS["claude-code"][0]!.id,
      effort: CHAT_EFFORTS[1],
      panelOpen: true,
      credentialOpen: false,
      setModel: (model) => set({ model }),
      setEffort: (effort) => set({ effort }),
      setPanelOpen: (panelOpen) => set({ panelOpen }),
      setCredentialOpen: (credentialOpen) => set({ credentialOpen }),
    }),
    {
      name: "mate.chat.model",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ model, effort, panelOpen }) => ({ model, effort, panelOpen }),
      // A model or effort a later Studio no longer offers falls back to the default.
      merge: (stored, current) => {
        const { model, effort, panelOpen } = (stored ?? {}) as Partial<ChatUiState>;
        return {
          ...current,
          ...(model && chatModel("claude-code", model) ? { model } : {}),
          ...(effort && CHAT_EFFORTS.includes(effort) ? { effort } : {}),
          ...(typeof panelOpen === "boolean" ? { panelOpen } : {}),
        };
      },
    },
  ),
);
