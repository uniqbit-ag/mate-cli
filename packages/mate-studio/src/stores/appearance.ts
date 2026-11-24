import { RAIL_STORAGE_KEY, THEME_STORAGE_KEY } from "../shell/prepaint";
import { create } from "zustand";

export type Theme = "system" | "dark" | "light";
type Rail = "full" | "min";

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

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a blocked web store only costs the preference, never the page */
  }
}

interface AppearanceState {
  theme: Theme;
  /** The navigation sidebar: labels shown, or icons only. */
  rail: Rail;
  /** Reads the remembered appearance once the page runs; the pre-paint script already applied it. */
  hydrate(): void;
  cycle(): void;
  toggleRail(): void;
}

/** The chosen appearance and sidebar width, remembered in this browser only. */
export const useAppearance = create<AppearanceState>((set, get) => ({
  theme: "system",
  rail: "full",
  hydrate: () =>
    set({
      theme: readTheme(),
      rail: document.documentElement.getAttribute("data-rail") === "min" ? "min" : "full",
    }),
  cycle: () => {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(get().theme) + 1) % THEME_CYCLE.length]!;
    applyTheme(next);
    save(THEME_STORAGE_KEY, next);
    set({ theme: next });
  },
  toggleRail: () => {
    const next: Rail = get().rail === "min" ? "full" : "min";
    if (next === "min") document.documentElement.setAttribute("data-rail", "min");
    else document.documentElement.removeAttribute("data-rail");
    save(RAIL_STORAGE_KEY, next);
    set({ rail: next });
  },
}));
