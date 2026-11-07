import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Icon } from "../../components/icon";
import { EmptyNote, ListCard, PAGE_PAD, ROW } from "../../components/view-parts";
import { cn } from "../../lib/cn";
import { formatReportTime } from "../../lib/report-time";
import { reportsQuery, type ReportSummary } from "../../lib/studio-queries";
import { PanelHead, SidePanel } from "../../shell/panel";
import { useAppearance } from "../../stores/appearance";
import { usePageUi } from "../../stores/page-ui";
import { reportSrc } from "./report-url";

/** The report the address names, as `#report=<id>`. */
const REPORT_ID = /(?:^|[#&])report=([0-9a-f]{32})/;

function setAddress(id: string | null): void {
  try {
    const url = `${location.pathname}${location.search}${id ? `#report=${id}` : ""}`;
    history.replaceState(history.state, "", url);
  } catch {
    /* the address is a convenience */
  }
}

/** One report in the panel: a link to it on its own, and the report in a sandboxed frame. */
export function ReportDetail({ report, src }: { report: ReportSummary; src: string }) {
  return (
    <>
      <PanelHead title={report.title} kicker={<span>{formatReportTime(report.createdAt)}</span>}>
        <a
          id="reports-open"
          className="inline-flex items-center gap-1.5 text-sm"
          href={src}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Icon name="external" className="size-3.5" /> Open in new tab
        </a>
      </PanelHead>
      <iframe
        key={src}
        id="reports-frame"
        className="min-h-0 w-full flex-1 border-0 bg-page"
        title="Hosted report"
        sandbox="allow-scripts allow-modals"
        referrerPolicy="no-referrer"
        src={src}
      />
    </>
  );
}

/**
 * Hosted reports, newest first; one opens in the panel in a sandboxed frame. A new report lists
 * as it is published; the frame reloads in the appearance chosen in Studio.
 */
export function Reports({ companion }: { companion: string }) {
  const reports = useQuery(reportsQuery(companion));
  const theme = useAppearance((state) => state.theme);
  const clearReports = usePageUi((state) => state.clearReports);
  // The address may name a report (`#report=<id>`), e.g. from the new-report notice.
  const named = REPORT_ID.exec(useLocation({ select: (location) => `#${location.hash}` }))?.[1];
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  useEffect(clearReports, [clearReports]);

  const list = reports.data ?? [];
  const wanted = chosen === undefined ? (named ?? null) : chosen;
  const open = list.find((report) => report.id === wanted) ?? null;
  const select = (id: string | null) => {
    setChosen(id);
    setAddress(id);
  };
  const src = open ? reportSrc(open.id, theme) : null;

  return (
    <section
      className={cn(PAGE_PAD, "grid content-start gap-3 pb-10")}
      data-reports-view
      aria-label="Hosted reports"
    >
      {list.length === 0 ? (
        <EmptyNote>
          <span id="reports-empty">No hosted reports yet.</span>
        </EmptyNote>
      ) : (
        <ListCard title="Reports" count={list.length} hint="Newest first">
          <ul id="reports-list" className="m-0 list-none p-0" aria-label="Reports">
            {list.map((report) => (
              <li key={report.id}>
                <button
                  type="button"
                  className={cn(ROW, "grid grid-cols-[minmax(0,1fr)_auto]")}
                  data-report-id={report.id}
                  aria-current={report.id === open?.id ? "true" : undefined}
                  onClick={() => select(report.id)}
                >
                  <span className="truncate text-sm" data-report-title>
                    {report.title}
                  </span>
                  <span className="font-mono text-xs text-muted" data-report-time>
                    {formatReportTime(report.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </ListCard>
      )}
      <SidePanel
        items={list.map((report) => report.id)}
        current={open?.id ?? null}
        onSelect={select}
        wide
        title={open ? `Report ${open.title}` : "Report"}
      >
        {open && src ? <ReportDetail report={open} src={src} /> : null}
      </SidePanel>
    </section>
  );
}
