import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useMatches } from "@tanstack/react-router";
import { type StudioView } from "@uniqbit/mate-core/studio";
import { COMPANION_STORAGE_KEY } from "./prepaint";
import { useEffect } from "react";

import { PageHeader } from "../components/view-parts";
import { TooltipProvider } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { useStudioEvents } from "../lib/events";
import { useStudioClicks } from "../lib/page-actions";
import { usePrefetchViews } from "../lib/prefetch-views";
import { useAppearance } from "../stores/appearance";
import { usePageUi } from "../stores/page-ui";
import { CommandPalette } from "./command-palette";
import { CompanionPicker } from "./companion-picker";
import { shellQuery } from "../lib/studio-queries";
import type { StudioSearch } from "../lib/search";
import { NavigationProgress } from "./navigation-progress";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";
import { VIEW_DESCRIPTIONS, VIEW_TITLES } from "./views";
import { TerminalSidebar } from "../terminal/terminal-sidebar";

/** Cmd/Ctrl+Backslash collapses the sidebar to icons and back. */
function useRailKey(): void {
  const toggleRail = useAppearance((state) => state.toggleRail);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        toggleRail();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => document.removeEventListener("keydown", keydown, true);
  }, [toggleRail]);
}

/** The top bar, sidebar and page header around every view; the view comes from the matched route. */
export function StudioLayout({ search }: { search: StudioSearch }) {
  const { data: shell } = useSuspenseQuery(shellQuery(search));
  const view =
    useMatches({
      select: (matches) => matches.findLast((match) => match.staticData.view)?.staticData.view,
    }) ?? "dashboard";
  const digest = shell.selected?.digest;
  useStudioEvents(digest);
  useStudioClicks();
  useRailKey();
  usePrefetchViews(shell.selected ? search : {}, shell.studioMode, shell.enabledModes);
  useEffect(() => {
    if (!digest) return;
    try {
      localStorage.setItem(COMPANION_STORAGE_KEY, digest);
    } catch {
      /* a blocked web store only costs the restore, never the page */
    }
  }, [digest]);
  return (
    <TooltipProvider>
      <div
        className="studio-frame"
        data-companion={digest}
        data-terminal={shell.terminal ? "" : undefined}
        data-picker={shell.selected ? undefined : ""}
      >
        <NavigationProgress />
        <TopBar shell={shell} search={search} />
        {/* Choosing a companion is the whole page: no views to navigate yet. */}
        {shell.selected ? <Sidebar shell={shell} search={search} view={view} /> : null}
        <main className="studio-main flex min-h-0 min-w-0 flex-col overflow-auto" id="studio-main">
          {shell.selected ? (
            <>
              <PageHeader
                title={VIEW_TITLES[view]}
                description={VIEW_DESCRIPTIONS[shell.studioMode][view]}
              />
              <div className="flex min-h-0 flex-1 flex-col pt-3">
                <Outlet />
              </div>
            </>
          ) : (
            <CompanionPicker
              companions={shell.companions}
              writable={shell.writable}
              factoryMode={shell.factoryMode}
            />
          )}
        </main>
        {shell.terminal ? <TerminalSidebar terminal={shell.terminal} /> : null}
      </div>
      <CommandPalette shell={shell} search={search} />
      <Toasts search={search} />
    </TooltipProvider>
  );
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    view?: StudioView;
  }
}

const TOAST =
  "toast pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-control border border-rule bg-surface px-3.5 py-1.5 text-sm text-text opacity-0 shadow-float transition-opacity duration-150 data-[shown=true]:opacity-100";

/** The copy confirmation, and a report published while another view is shown. */
function Toasts({ search }: { search: StudioSearch }) {
  const toast = usePageUi((state) => state.toast);
  const report = usePageUi((state) => state.report);
  return (
    <>
      <div className={TOAST} id="studio-toast" data-shown={toast ? "true" : "false"}>
        {toast}
      </div>
      <div
        className={cn(
          TOAST,
          "toast-report bottom-16 flex items-center gap-2.5 data-[shown=true]:pointer-events-auto",
        )}
        id="reports-toast"
        data-shown={report ? "true" : "false"}
        role="status"
      >
        <span id="reports-toast-title">{report ? `New report: ${report.title}` : null}</span>
        {report ? (
          <Link
            id="reports-toast-open"
            className="font-semibold"
            to="/reports"
            search={search}
            hash={`report=${report.id}`}
          >
            Open
          </Link>
        ) : null}
      </div>
    </>
  );
}
