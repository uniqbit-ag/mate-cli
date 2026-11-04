import {
  type StudioCompanionPayload,
  type StudioReportSummary,
  type StudioShippedChange,
} from "@uniqbit/mate-core/studio";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { groupSpecsByArea } from "../specs/spec-areas";
import { formatReportTime } from "../../lib/report-time";
import { recentlyChangedSpecs } from "./changed-specs";
import { Warnings } from "../warnings";

const SHIPPED_LIMIT = 8;
const CHANGED_SPECS_LIMIT = 10;
const REPORTS_LIMIT = 5;

const ARCHIVE_DIR = "openspec/changes/archive";
const NO_REPORTS: StudioReportSummary[] = [];

interface AnalystOverviewProps {
  payload: Pick<StudioCompanionPayload, "specs" | "shipped" | "warnings">;
  /** Newest first; `null` when the listing could not be read, absent when not listed. */
  reports?: StudioReportSummary[] | null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Published state only: specs, shipped archives, and hosted reports; never active work. */
export function AnalystOverview({ payload, reports = NO_REPORTS }: AnalystOverviewProps) {
  return (
    <div className="analyst-overview">
      <SystemSummary payload={payload} />
      <div className="analyst-grid">
        <Shipped shipped={payload.shipped} />
        <div className="analyst-side">
          <ChangedSpecs shipped={payload.shipped} />
          <RecentReports reports={reports} />
        </div>
      </div>
      <Warnings warnings={payload.warnings} />
    </div>
  );
}

function SystemSummary({
  payload,
}: {
  payload: Pick<StudioCompanionPayload, "specs" | "shipped" | "warnings">;
}) {
  const { specs } = payload;
  const requirements = specs.reduce((sum, spec) => sum + (spec.requirementCount ?? 0), 0);
  const invalid = specs.filter((spec) => spec.valid === false).length;
  const areas = groupSpecsByArea(specs);
  const stats: [string, number, boolean][] = [
    ["capabilities", specs.length, false],
    ["requirements", requirements, false],
    ["invalid specs", invalid, invalid > 0],
  ];

  return (
    <section className="analyst-summary" aria-labelledby="analyst-summary-title">
      <div className="analyst-summary-head">
        <h2 id="analyst-summary-title">What the system does</h2>
        <Link className="analyst-more" to="/specs" search={(previous) => previous}>
          All specs
        </Link>
      </div>
      {specs.length === 0 ? (
        <p className="empty">No specs published in this companion.</p>
      ) : (
        <div className="analyst-summary-body">
          <dl className="analyst-stats">
            {stats.map(([label, value, alert]) => (
              <div key={label} className="analyst-stat" data-alert={alert ? "true" : undefined}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <ul className="analyst-areas" aria-label="Capabilities per Area">
            {areas.map(([area, areaSpecs]) => (
              <li key={area}>
                <span className="mono" title={area}>
                  {area}
                </span>
                <span className="analyst-count">{areaSpecs.length}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Part({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section className="analyst-part" aria-labelledby={id}>
      <div className="analyst-part-head">
        <h3 id={id}>{title}</h3>
        <span className="analyst-part-note">{note}</span>
      </div>
      {children}
    </section>
  );
}

function Shipped({ shipped }: { shipped: StudioShippedChange[] }) {
  const shown = shipped.slice(0, SHIPPED_LIMIT);
  return (
    <Part
      id="analyst-shipped"
      title="Recently shipped"
      note={
        shipped.length > shown.length
          ? `newest ${shown.length} of ${shipped.length}`
          : plural(shipped.length, "change", "changes")
      }
    >
      {shown.length === 0 ? (
        <p className="empty">No shipped changes yet.</p>
      ) : (
        <ol className="analyst-list">
          {shown.map((change) => {
            const dir = `${ARCHIVE_DIR}/${change.anchor}`;
            const target = change.hasProposal ? { path: `${dir}/proposal.md` } : { dir };
            return (
              <li key={change.anchor} className="analyst-row">
                <Link
                  className="analyst-row-title"
                  to="/vault"
                  search={(previous) => ({ ...previous, ...target })}
                >
                  {change.name}
                </Link>
                <span className="analyst-row-meta">
                  <span>{`archived ${change.archivedOn}`}</span>
                  {change.specs.length === 0 ? (
                    <span>no spec changes</span>
                  ) : (
                    <span className="analyst-caps">{change.specs.join(", ")}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Part>
  );
}

function ChangedSpecs({ shipped }: { shipped: StudioShippedChange[] }) {
  const shown = recentlyChangedSpecs(shipped).slice(0, CHANGED_SPECS_LIMIT);
  return (
    <Part id="analyst-changed-specs" title="Recently changed specs" note="by shipped change">
      {shown.length === 0 ? (
        <p className="empty">No specs changed by shipped changes yet.</p>
      ) : (
        <ol className="analyst-list">
          {shown.map((spec) => (
            <li key={spec.capability} className="analyst-row">
              <Link
                className="analyst-row-title"
                to="/vault"
                search={(previous) => ({
                  ...previous,
                  path: `openspec/specs/${spec.capability}/spec.md`,
                })}
              >
                {spec.capability}
              </Link>
              <span className="analyst-row-meta">
                <span>{spec.archivedOn}</span>
                <span className="analyst-caps">{spec.change}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Part>
  );
}

function RecentReports({ reports }: { reports: StudioReportSummary[] | null }) {
  return (
    <Part id="analyst-reports" title="Recent reports" note="hosted in Studio">
      {reports === null ? (
        <p className="empty">Reports could not be listed.</p>
      ) : (
        <ReportList shown={reports.slice(0, REPORTS_LIMIT)} />
      )}
    </Part>
  );
}

function ReportList({ shown }: { shown: StudioReportSummary[] }) {
  if (shown.length === 0) return <p className="empty">No hosted reports yet.</p>;
  return (
    <ol className="analyst-list">
      {shown.map((report) => (
        <li key={report.id} className="analyst-row">
          <Link
            className="analyst-row-title analyst-report-title"
            to="/reports"
            search={(previous) => previous}
            hash={`report=${report.id}`}
          >
            {report.title}
          </Link>
          <span className="analyst-row-meta">
            <span>{formatReportTime(report.createdAt)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
