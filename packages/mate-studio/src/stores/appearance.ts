import { THEME_STORAGE_KEY } from "../shell/prepaint";
import { create } from "zustand";

export type Theme = "system" | "dark" | "light";

const THEME_CYCLE: Theme[] = ["system", "dark", "light"];

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
    return stored && THEME_CYCLE.includes(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

interface AppearanceState {
  theme: Theme;
  /** Reads the remembered appearance once the page runs; the pre-paint script already applied it. */
  hydrate(): void;
  cycle(): void;
}

/** The chosen appearance, remembered in local storage like the server-rendered views did. */
export const useAppearance = create<AppearanceState>((set, get) => ({
  theme: "system",
  hydrate: () => set({ theme: readTheme() }),
  cycle: () => {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(get().theme) + 1) % THEME_CYCLE.length]!;
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* a blocked web store only costs the preference, never the page */
    }
    set({ theme: next });
  },
}));
