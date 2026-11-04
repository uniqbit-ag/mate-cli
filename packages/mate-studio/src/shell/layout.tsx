import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useMatches } from "@tanstack/react-router";
import { type StudioView } from "@uniqbit/mate-core/studio";
import { COMPANION_STORAGE_KEY } from "./prepaint";
import { useEffect } from "react";

import { useStudioEvents } from "../lib/events";
import { useStudioClicks } from "../lib/page-actions";
import { usePageUi } from "../stores/page-ui";
import { CompanionPicker } from "./companion-picker";
import { shellQuery } from "../lib/queries";
import type { StudioSearch } from "../lib/search";
import { PageHeader } from "./page-header";
import { Sidebar } from "./sidebar";
import { TerminalDrawerButton, TerminalSidebar } from "../terminal/terminal-sidebar";

/** The sidebar and page header around every view; the view comes from the matched route. */
export function StudioLayout({ search }: { search: StudioSearch }) {
  const { data: shell } = useSuspenseQuery(shellQuery(search));
  const view =
    useMatches({
      select: (matches) => matches.findLast((match) => match.staticData.view)?.staticData.view,
    }) ?? "dashboard";
  const digest = shell.selected?.digest;
  useStudioEvents(digest);
  useStudioClicks();
  useEffect(() => {
    if (!digest) return;
    try {
      localStorage.setItem(COMPANION_STORAGE_KEY, digest);
    } catch {
      /* a blocked web store only costs the restore, never the page */
    }
  }, [digest]);
  return (
    <>
      <div
        className="shell"
        data-companion={digest}
        data-terminal={shell.terminal ? "" : undefined}
      >
        <Sidebar shell={shell} search={search} view={view} />
        <main className="main">
          <PageHeader shell={shell} view={view} />
          {shell.selected ? <Outlet /> : <CompanionPicker companions={shell.companions} />}
        </main>
        {shell.terminal ? <TerminalSidebar terminal={shell.terminal} /> : null}
      </div>
      {shell.terminal ? <TerminalDrawerButton /> : null}
      <Toasts search={search} />
    </>
  );
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    view?: StudioView;
  }
}

/** The copy confirmation, and a report published while another view is shown. */
function Toasts({ search }: { search: StudioSearch }) {
  const toast = usePageUi((state) => state.toast);
  const report = usePageUi((state) => state.report);
  return (
    <>
      <div className="toast" id="studio-toast" data-shown={toast ? "true" : "false"}>
        {toast}
      </div>
      <div
        className="toast toast-report"
        id="reports-toast"
        data-shown={report ? "true" : "false"}
        role="status"
      >
        <span id="reports-toast-title">{report ? `New report: ${report.title}` : null}</span>
        {report ? (
          <Link id="reports-toast-open" to="/reports" search={search} hash={`report=${report.id}`}>
            Open
          </Link>
        ) : null}
      </div>
    </>
  );
}
