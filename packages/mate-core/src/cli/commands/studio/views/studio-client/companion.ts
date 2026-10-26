import { COMPANION_STORAGE_KEY } from "./keys";

/** Remembers the companion the served page resolved, for the next visit's restore. */
export function rememberCompanion(): void {
  const scope = document.querySelector("[data-companion]");
  const current = scope && scope.getAttribute("data-companion");
  if (!current) return;
  try {
    localStorage.setItem(COMPANION_STORAGE_KEY, current);
  } catch {
    /* a blocked web store only costs the next visit, never the page */
  }
}
