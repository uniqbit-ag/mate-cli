/** @jsxImportSource hono/jsx */

import { REFRESH_PARAM, type StudioSelection } from "../selection";
import { STUDIO_CLIENT_SCRIPT, STUDIO_PREPAINT_SCRIPT } from "./client";
import { CompanionSelector } from "./companion-selector";
import { Dashboard } from "./dashboard/index";
import { CompanionError } from "./error";
import { formatCollectedAt, type StudioPage } from "./model";
import { STUDIO_STYLES } from "./styles";
import { Workflow } from "./workflow/index";

const STUDIO_TITLE = "Mate Studio";

/**
 * `<style>` and `<script>` are HTML raw-text elements: a character reference
 * inside one is not decoded, so escaped content would be broken CSS and broken
 * JavaScript. They carry authored source only — never a payload value — and are
 * emitted as literal markup here, which is why no view ever reaches for an
 * escape hatch around the renderer's escaping.
 */
export function renderStudioDocument(page: StudioPage): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${STUDIO_TITLE}</title>
<style>${STUDIO_STYLES}</style>
<script>${STUDIO_PREPAINT_SCRIPT}</script>
</head>
<body>${String(<StudioShell page={page} />)}
<script>${STUDIO_CLIENT_SCRIPT}</script>
</body>
</html>
`;
}

function StudioShell({ page }: { page: StudioPage }) {
  return (
    <>
      <div className="shell">
        <Sidebar page={page} />
        <main className="main">
          <Content page={page} />
        </main>
      </div>
      <div className="toast" id="studio-toast" data-shown="false" />
    </>
  );
}

function Content({ page }: { page: StudioPage }) {
  if (page.error) {
    return <CompanionError companionPath={page.error.companionPath} reason={page.error.reason} />;
  }
  if (!page.payload) {
    return (
      <section className="panel">
        <p className="empty">Select a Companion Repository.</p>
      </section>
    );
  }
  return page.selection.view === "workflow" ? (
    <Workflow payload={page.payload} />
  ) : (
    <Dashboard payload={page.payload} />
  );
}

function Sidebar({ page }: { page: StudioPage }) {
  return (
    <aside className="rail studio-sidebar" id="studio-rail">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark">M</span>
        <div className="sidebar-brand-copy">
          <strong>{STUDIO_TITLE}</strong>
        </div>
      </div>
      <CompanionSelector inventory={page.inventory} selection={page.selection} />
      <ViewNav selection={page.selection} />
      <Metrics page={page} />
      <Footer page={page} />
    </aside>
  );
}

/**
 * Submit buttons, so switching a view is a navigation to the URL naming it and
 * the browser's history moves between rendered states.
 */
function ViewNav({ selection }: { selection: StudioSelection }) {
  return (
    <nav className="sidebar-nav" aria-label="Studio views">
      <span className="sidebar-label">Navigate</span>
      <form method="get" action="/">
        <SelectionFields selection={selection} omit="view" />
        <div className="sidebar-nav-list">
          <button
            type="submit"
            name="view"
            value="dashboard"
            aria-pressed={selection.view === "dashboard"}
          >
            <span>Overview</span>
          </button>
          <button
            type="submit"
            name="view"
            value="workflow"
            aria-pressed={selection.view === "workflow"}
          >
            <span>Workflow</span>
          </button>
        </div>
      </form>
    </nav>
  );
}

function Metrics({ page }: { page: StudioPage }) {
  const payload = page.payload;
  if (!payload) return null;
  const metrics: [string, number][] = [
    ["changes", payload.changes.length],
    ["done", payload.changes.filter((change) => change.status === "complete").length],
    ["specs", payload.specs.length],
  ];

  return (
    <div className="sidebar-metrics" id="studio-stats">
      {metrics.map(([label, value]) => (
        <div key={label} className="sidebar-metric">
          <strong>{value}</strong>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The refresh control is the only thing that collects again, so it is the only
 * control that names the refresh parameter.
 */
function Footer({ page }: { page: StudioPage }) {
  return (
    <div className="sidebar-footer">
      <div className="sidebar-footer-row">
        <span className="muted">
          {page.collectedAt === null
            ? "no state collected"
            : `state as of ${formatCollectedAt(page.collectedAt)}`}
        </span>
        <form method="get" action="/">
          <SelectionFields selection={page.selection} />
          <input type="hidden" name={REFRESH_PARAM} value="1" />
          <button type="submit">Refresh</button>
        </form>
      </div>
      <button id="studio-theme" type="button" data-theme-state="system">
        Theme: system
      </button>
    </div>
  );
}

/** Carries the parts of the selection a control is not itself changing. */
function SelectionFields({
  selection,
  omit,
}: {
  selection: StudioSelection;
  omit?: keyof StudioSelection;
}) {
  return (
    <>
      {selection.companionDigest && omit !== "companionDigest" ? (
        <input type="hidden" name="companion" value={selection.companionDigest} />
      ) : null}
      {selection.view !== "dashboard" && omit !== "view" ? (
        <input type="hidden" name="view" value={selection.view} />
      ) : null}
    </>
  );
}
