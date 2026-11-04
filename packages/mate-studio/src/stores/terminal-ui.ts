import {
  TERMINAL_COLLAPSED_KEY,
  TERMINAL_MAX_WIDTH_RATIO,
  TERMINAL_MIN_WIDTH,
  TERMINAL_WIDTH_KEY,
} from "../terminal/keys";
import { create } from "zustand";

/** What other views ask of the agent terminal; the sidebar registers it while mounted. */
export interface TerminalController {
  startWorkset(id: string): void;
  attach(sessionId: string): void;
  /** A registered skill action; with several agents the person picks one. */
  runAction(task: { action: string; subject: string; agents: string[] }): void;
}

interface TerminalUiState {
  collapsed: boolean;
  drawerOpen: boolean;
  /** The agent this tab views, or "pending" until a stored session reattaches; run buttons hide while set. */
  viewing: string | null;
  controller: TerminalController | null;
  setCollapsed(collapsed: boolean): void;
  setDrawerOpen(open: boolean): void;
  setWidth(px: number, save: boolean): void;
  setViewing(agent: string | null): void;
  register(controller: TerminalController | null): void;
  /** Expands the sidebar, or opens the drawer below the side-by-side breakpoint. */
  reveal(): void;
}

function clampWidth(px: number): number {
  return Math.round(
    Math.max(TERMINAL_MIN_WIDTH, Math.min(px, window.innerWidth * TERMINAL_MAX_WIDTH_RATIO)),
  );
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* only the preference is lost */
  }
}

/**
 * The terminal sidebar's chrome. The document attributes and the width variable stay what the
 * stylesheet and the pre-paint script already use, so a reload paints the remembered layout.
 */
export const useTerminalUi = create<TerminalUiState>((set, get) => ({
  collapsed: false,
  drawerOpen: false,
  viewing: null,
  controller: null,
  setCollapsed: (collapsed) => {
    document.documentElement.toggleAttribute("data-terminal-collapsed", collapsed);
    save(TERMINAL_COLLAPSED_KEY, String(collapsed));
    set({ collapsed });
  },
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  setWidth: (px, persist) => {
    const width = clampWidth(px);
    document.documentElement.style.setProperty("--terminal-width", `${width}px`);
    if (persist) save(TERMINAL_WIDTH_KEY, String(width));
  },
  setViewing: (viewing) => {
    if (viewing) document.documentElement.setAttribute("data-agent-viewed", viewing);
    else document.documentElement.removeAttribute("data-agent-viewed");
    set({ viewing });
  },
  register: (controller) => set({ controller }),
  reveal: () => {
    if (get().collapsed) get().setCollapsed(false);
    const opener = document.getElementById("terminal-drawer-open");
    if (opener && getComputedStyle(opener).display !== "none") set({ drawerOpen: true });
  },
}));

/** Applies the remembered layout before paint; authored source only. */
export const TERMINAL_PREPAINT_SCRIPT = `(function () {
  try {
    var width = parseInt(localStorage.getItem(${JSON.stringify(TERMINAL_WIDTH_KEY)}) || "", 10);
    if (width > 0) document.documentElement.style.setProperty("--terminal-width", Math.round(Math.max(${TERMINAL_MIN_WIDTH}, Math.min(width, window.innerWidth * ${TERMINAL_MAX_WIDTH_RATIO}))) + "px");
    if (localStorage.getItem(${JSON.stringify(TERMINAL_COLLAPSED_KEY)}) === "true") {
      document.documentElement.setAttribute("data-terminal-collapsed", "");
    }
  } catch (error) {
    /* a blocked web store only costs the preference, never the page */
  }
})();`;
