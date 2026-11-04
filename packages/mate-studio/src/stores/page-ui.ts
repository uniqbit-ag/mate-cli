import { create } from "zustand";

interface PageUiState {
  /** A short confirmation, such as "copied prompt". */
  toast: string | null;
  /** The newest report published while the Reports view was not shown. */
  report: { id: string; title: string } | null;
  /** A report arrived since the Reports view was last open. */
  reportsBadge: boolean;
  announce(message: string): void;
  announceReport(report: { id: string; title: string }): void;
  clearReports(): void;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let reportTimer: ReturnType<typeof setTimeout> | undefined;

export const usePageUi = create<PageUiState>((set) => ({
  toast: null,
  report: null,
  reportsBadge: false,
  announce: (toast) => {
    set({ toast });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 1400);
  },
  announceReport: (report) => {
    set({ report, reportsBadge: true });
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => set({ report: null }), 10_000);
  },
  clearReports: () => set({ reportsBadge: false, report: null }),
}));

/** Copies text and confirms it in the page; a blocked clipboard costs the copy, never the page. */
export function copyText(text: string, label: string): void {
  const { announce } = usePageUi.getState();
  if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
    announce("copying is blocked in this browser");
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => announce(`copied ${label}`),
    () => announce("copying is blocked in this browser"),
  );
}
