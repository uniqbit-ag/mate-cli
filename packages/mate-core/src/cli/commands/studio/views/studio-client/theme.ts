import { THEME_STORAGE_KEY } from "./keys";

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

function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* a blocked web store only costs the preference, never the page */
  }
}

let theme: Theme = "system";
/** Set by the Reports view to reload the shown report in the new appearance. */
let onThemeChange: (() => void) | null = null;

export function currentTheme(): Theme {
  return theme;
}

export function setThemeListener(listener: (() => void) | null): void {
  onThemeChange = listener;
}

function applyTheme(next: Theme): void {
  theme = next;
  if (onThemeChange) onThemeChange();
  const root = document.documentElement;
  if (next === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", next);
  const control = document.getElementById("studio-theme");
  if (control) {
    control.textContent = `Theme: ${next}`;
    control.setAttribute("data-theme-state", next);
  }
}

/** Applies the remembered appearance and lets the control cycle it. */
export function wireTheme(): void {
  onThemeChange = null;
  applyTheme(readTheme());
}

export function wireThemeToggle(): void {
  const toggle = document.getElementById("studio-theme");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]!;
    applyTheme(next);
    storeTheme(next);
  });
}
