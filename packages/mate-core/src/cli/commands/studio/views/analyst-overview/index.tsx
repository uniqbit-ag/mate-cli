/** @jsxImportSource hono/jsx */

import type { StudioCompanionPayload, StudioShippedChange } from "../../payload";
import { openFile, openFolder, type StudioSelection, switchView, toHref } from "../../selection";
import type { StudioReportSummary } from "../model";
import { groupSpecsByArea } from "../specs/index";
import { Warnings } from "../warnings";

const SHIPPED_LIMIT = 8;
const CHANGED_SPECS_LIMIT = 10;
const REPORTS_LIMIT = 5;

const ARCHIVE_DIR = "openspec/changes/archive";
const NO_REPORTS: StudioReportSummary[] = [];

interface AnalystOverviewProps {
  payload: StudioCompanionPayload;
  selection: StudioSelection;
  /** Newest first; `null` when the listing could not be read, absent when not listed. */
  reports?: StudioReportSummary[] | null;
}

interface ChangedSpec {
  capability: string;
  change: string;
  archivedOn: string;
}

/** Each capability once, at the newest shipped change that touched it. */
export function recentlyChangedSpecs(shipped: StudioShippedChange[]): ChangedSpec[] {
  const seen = new Set<string>();
  const changed: ChangedSpec[] = [];
  for (const change of shipped) {
    for (const capability of change.specs) {
      if (seen.has(capability)) continue;
      seen.add(capability);
      changed.push({ capability, change: change.name, archivedOn: change.archivedOn });
    }
  }
  return changed;
}

function pad(part: number): string {
  return String(part).padStart(2, "0");
}

/** Local date and minute: Studio serves the browser on the same machine. */
function formatReportTime(createdAt: number): string {
  const at = new Date(createdAt);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Published state only: specs, shipped archives, and hosted reports; never active work. */
export function AnalystOverview({
  payload,
  selection,
  reports = NO_REPORTS,
}: AnalystOverviewProps) {
  return (
    <div className="analyst-overview">
      <SystemSummary payload={payload} selection={selection} />
      <div className="analyst-grid">
        <Shipped shipped={payload.shipped} selection={selection} />
        <div className="analyst-side">
          <ChangedSpecs shipped={payload.shipped} selection={selection} />
          <RecentReports reports={reports} selection={selection} />
        </div>
      </div>
      <Warnings warnings={payload.warnings} />
    </div>
  );
}

function SystemSummary({
  payload,
  selection,
}: {
  payload: StudioCompanionPayload;
  selection: StudioSelection;
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
        <a className="analyst-more" href={toHref(switchView(selection, "specs"))}>
          All specs
        </a>
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
  children: unknown;
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

function Shipped({
  shipped,
  selection,
}: {
  shipped: StudioShippedChange[];
  selection: StudioSelection;
}) {
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
            const target = change.hasProposal
              ? openFile(selection, `${dir}/proposal.md`)
              : openFolder(selection, dir);
            return (
              <li key={change.anchor} className="analyst-row">
                <a className="analyst-row-title" href={toHref(target)}>
                  {change.name}
                </a>
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

function ChangedSpecs({
  shipped,
  selection,
}: {
  shipped: StudioShippedChange[];
  selection: StudioSelection;
}) {
  const shown = recentlyChangedSpecs(shipped).slice(0, CHANGED_SPECS_LIMIT);
  return (
    <Part id="analyst-changed-specs" title="Recently changed specs" note="by shipped change">
      {shown.length === 0 ? (
        <p className="empty">No specs changed by shipped changes yet.</p>
      ) : (
        <ol className="analyst-list">
          {shown.map((spec) => (
            <li key={spec.capability} className="analyst-row">
              <a
                className="analyst-row-title"
                href={toHref(openFile(selection, `openspec/specs/${spec.capability}/spec.md`))}
              >
                {spec.capability}
              </a>
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

function RecentReports({
  reports,
  selection,
}: {
  reports: StudioReportSummary[] | null;
  selection: StudioSelection;
}) {
  const shown = (reports ?? []).slice(0, REPORTS_LIMIT);
  const href = toHref(switchView(selection, "reports"));
  return (
    <Part id="analyst-reports" title="Recent reports" note="hosted in Studio">
      {reports === null ? (
        <p className="empty">Reports could not be listed.</p>
      ) : shown.length === 0 ? (
        <p className="empty">No hosted reports yet.</p>
      ) : (
        <ol className="analyst-list">
          {shown.map((report) => (
            <li key={report.id} className="analyst-row">
              <a className="analyst-row-title analyst-report-title" href={href}>
                {report.title}
              </a>
              <span className="analyst-row-meta">
                <span>{formatReportTime(report.createdAt)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Part>
  );
}
