import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { REPORT_VIEW_PREFIX } from "@uniqbit/mate-core/studio";
import { useEffect, useState } from "react";

import { usePageUi } from "../../stores/page-ui";
import { formatReportTime } from "../../lib/report-time";
import { REPORT_ID, reportsQuery, type ReportSummary } from "./reports-query";
import { type Theme, useAppearance } from "../../stores/appearance";

/** The chosen report while listed, else the one the address names, else the newest. */
function shownReport(
  list: ReportSummary[],
  chosen: string | null,
  named: string | undefined,
): string | null {
  const listed = (id: string | null | undefined) => list.some((report) => report.id === id);
  if (listed(chosen)) return chosen;
  if (listed(named)) return named!;
  return list[0]?.id ?? null;
}

function reportSrc(id: string, theme: Theme): string {
  const scheme = theme === "system" ? "" : `?scheme=${theme}`;
  return `${REPORT_VIEW_PREFIX}${id}${scheme}`;
}

/**
 * Hosted reports: the list, and the chosen one in a sandboxed frame. A new report lists as it
 * is published; the frame reloads in the appearance chosen in Studio.
 */
export function Reports({ companion }: { companion: string }) {
  const reports = useQuery(reportsQuery(companion));
  const theme = useAppearance((state) => state.theme);
  const clearReports = usePageUi((state) => state.clearReports);
  // The address may name a report (`#report=<id>`); otherwise the newest is shown.
  const named = REPORT_ID.exec(useLocation({ select: (location) => `#${location.hash}` }))?.[1];
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(clearReports, [clearReports]);

  const list = reports.data ?? [];
  const shown = shownReport(list, chosen, named);
  useEffect(() => {
    if (!shown) return;
    try {
      history.replaceState(history.state, "", `#report=${shown}`);
    } catch {
      /* the address is a convenience */
    }
  }, [shown]);

  const src = shown ? reportSrc(shown, theme) : null;
  return (
    <section className="view-section" data-reports-view aria-label="Hosted reports">
      <p className="view-summary">Reports published by agent sessions Studio started.</p>
      <div className="reports-layout">
        <div className="reports-side">
          <ul id="reports-list" className="reports-list" aria-label="Reports">
            {list.map((report) => (
              <li key={report.id}>
                <button
                  type="button"
                  data-report-id={report.id}
                  aria-pressed={report.id === shown}
                  onClick={() => setChosen(report.id)}
                >
                  <span data-report-title>{report.title}</span>
                  <span className="report-time" data-report-time>
                    {formatReportTime(report.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p id="reports-empty" className="empty" hidden={list.length > 0}>
            No hosted reports yet.
          </p>
        </div>
        <div className="reports-main">
          <div className="reports-bar">
            {src ? (
              <a id="reports-open" href={src} target="_blank" rel="noopener noreferrer">
                Open in new tab
              </a>
            ) : null}
          </div>
          {src ? (
            <iframe
              key={src}
              id="reports-frame"
              className="reports-frame"
              title="Hosted report"
              sandbox="allow-scripts allow-modals"
              referrerPolicy="no-referrer"
              src={src}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
