import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MODE_VIEWS,
  SHARED_VIEWS,
  type StudioMode,
  type StudioView,
} from "@uniqbit/mate-core/studio";

import type { IconName } from "../components/icon";
import type { StudioSearch } from "../lib/search";
import { useMediaQuery } from "../lib/use-media-query";
import { afterRefresh } from "../lib/studio-queries";
import { getShell } from "../server/shell";
import { useTerminalUi } from "../stores/terminal-ui";

/** What the frame's parts share: view order and icons, companion names, refresh and terminal. */

/** Navigation order; core decides which views a mode offers. */
const MODE_ORDER: readonly StudioView[] = ["dashboard", "workflow", "factory", "skills"];
const LIBRARY_ORDER: readonly StudioView[] = ["specs", "vault", "reports"];

export const VIEW_ICONS: Record<StudioView, IconName> = {
  dashboard: "home",
  workflow: "flow",
  factory: "factory",
  skills: "spark",
  specs: "doc",
  vault: "folder",
  reports: "chart",
};

/** Core's views in Studio's order; a view the order does not name yet goes last, never missing. */
function inOrder(views: readonly StudioView[], order: readonly StudioView[]): StudioView[] {
  const rank = (view: StudioView) => (order.includes(view) ? order.indexOf(view) : order.length);
  return views.toSorted((a, b) => rank(a) - rank(b));
}

/** The views a mode lists, in navigation order; Factory only where the broker runs. */
export function modeViews(mode: StudioMode, factoryMode: boolean): StudioView[] {
  return inOrder(MODE_VIEWS[mode], MODE_ORDER).filter((view) => factoryMode || view !== "factory");
}

export function libraryViews(): StudioView[] {
  return inOrder(SHARED_VIEWS, LIBRARY_ORDER);
}

export function companionName(companionPath: string): string {
  const segments = companionPath.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? companionPath;
}

/** Collects the selected companion again; the only control that does. */
export function useRefresh(search: StudioSearch) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => getShell({ data: { ...search, refresh: true } }),
    onSuccess: () => afterRefresh(queryClient, search.companion),
  });
}

/** Below this width the terminal is a drawer over the page, not a column beside it. */
const NARROW_FRAME = "(max-width: 1200px)";

const narrowFrame = (): boolean => window.matchMedia(NARROW_FRAME).matches;

/** Whether the terminal is a drawer; false on the server. */
export function useNarrowFrame(): boolean {
  return useMediaQuery(NARROW_FRAME);
}

/** An opened drawer overlays the page, so focus moves into it. */
function focusDrawer(): void {
  requestAnimationFrame(() => document.getElementById("terminal-drawer-close")?.focus());
}

/** Shows or hides the terminal: side by side it collapses, on a narrow window it is a drawer. */
export function toggleTerminal(): void {
  const ui = useTerminalUi.getState();
  if (!narrowFrame()) return ui.setCollapsed(!ui.collapsed);
  ui.setDrawerOpen(!ui.drawerOpen);
  if (!ui.drawerOpen) focusDrawer();
}

/** Shows the terminal; never hides it. */
export function openTerminal(): void {
  useTerminalUi.getState().reveal();
  if (narrowFrame()) focusDrawer();
}
