import { studioPaletteCss } from "./palette";

/**
 * Theme-aware by tokens: the colour tokens come from the brand palette shared with
 * reports (see `./palette`), dark is the default, light mode is applied through the
 * system preference or the inline toggle, and explicit theme attributes win over
 * media queries.
 */
export const STUDIO_STYLES = `
${studioPaletteCss()}
:root { --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; --sidebar-inset: 12px; --sidebar-radius: 12px; }

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
.shell { display: grid; grid-template-columns: calc(224px + var(--sidebar-inset)) minmax(0, 1fr); min-height: 100vh; }
@media (max-width: 900px) { .shell { grid-template-columns: 1fr; } }

.rail {
  background: var(--bg-rail);
  border-right: 1px solid var(--border);
  padding: 22px 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
a { color: var(--accent); }
select, button {
  font: inherit;
  color: inherit;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 11px;
  max-width: 100%;
}
/** Own chevron: the native one ignores padding and sits on the right border. */
select {
  width: 100%;
  appearance: none;
  padding-right: 32px;
  background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
  background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
  background-size: 5px 5px;
  background-repeat: no-repeat;
}
button { cursor: pointer; text-align: left; transition: border-color .15s, background .15s, color .15s; }
button:hover { border-color: var(--accent); background: var(--accent-soft); }
button:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.main { padding: 40px clamp(22px, 4vw, 64px) 72px; min-width: 0; background: var(--bg); }
.main > * { width: min(100%, 1180px); margin-right: auto; margin-left: auto; }
/** A view's content sits on the page; only items and details are cards. */
.view-section { display: grid; gap: 18px; min-width: 0; }
.view-summary { margin: 0; color: var(--muted); font-size: .8rem; }
.view-intro { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 24px; }
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 24px;
  margin-bottom: 16px;
}
h1 { margin: 0; font-size: 1.6rem; font-weight: 650; line-height: 1.2; letter-spacing: -.01em; }
h3 { color: var(--text); font-size: 1.05rem; font-weight: 700; margin: 0; letter-spacing: -.02em; }
h4 { font-size: .86rem; margin: 0 0 6px; font-family: var(--mono); }
.note { color: var(--muted); font-size: .82rem; margin: 5px 0 14px; }
.muted { color: var(--muted); font-size: .84rem; }
.mono { font-family: var(--mono); font-size: .86rem; }
code { font-family: var(--mono); font-size: .82rem; }
.empty { color: var(--muted); font-style: italic; margin: 0; }
.unready { color: var(--warn); }
option.unready { color: var(--warn); font-style: italic; }
option.placeholder { color: var(--muted); font-style: italic; }
.scroll { overflow-x: auto; }

.page-header { display: flex; align-items: stretch; justify-content: space-between; gap: 32px; padding-bottom: 24px; margin-bottom: 18px; border-bottom: 1px solid var(--border-soft); }
.page-heading { min-width: 0; }
.page-context { display: grid; align-content: start; gap: 6px; min-width: min(100%, 300px); max-width: 380px; padding: 0; border: 0; border-radius: 0; background: transparent; }
.page-context-label { color: var(--muted); font-size: .64rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.page-context code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.snapshot-status { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: .75rem; }
.snapshot-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--done); }
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
.section-note { margin: 4px 0 0; color: var(--muted); font-size: .8rem; }
.section-header h3 { color: var(--muted); font-family: inherit; font-size: .75rem; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }

table { border-collapse: collapse; width: 100%; font-size: .88rem; }
th, td { text-align: left; padding: 12px 10px; border-bottom: 1px solid var(--border-soft); vertical-align: top; }
th:first-child, td:first-child { padding-left: 0; }
th:last-child, td:last-child { padding-right: 0; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
tbody tr:hover td { background: var(--panel-soft); }
td.numeric { font-variant-numeric: tabular-nums; white-space: nowrap; }
.lookup-table td:first-child { min-width: 180px; }
.change-cell { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 8px; }
.change-cell .mono { min-width: 0; overflow-wrap: anywhere; }
.progress-label { display: block; }
.bar { display: block; margin-top: 7px; width: 120px; height: 5px; border-radius: 999px; background: var(--border); overflow: hidden; }
.bar-fill { display: block; height: 100%; background: var(--done); }
.artifact-list { display: flex; flex-wrap: wrap; gap: 5px 6px; }
.lookup-table .chip { margin: 0; padding: 2px 7px; font-size: .68rem; }
.status-chip { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-family: var(--mono); font-size: .68rem; white-space: nowrap; }
.status-chip[data-status="complete"] { color: var(--done); }
.status-chip:is([data-status="active"], [data-status="in-progress"]) { color: var(--info); }

/** Status markers use the report's tone shapes: dot complete, diamond active, square invalid, triangle warning. */
.status-chip::before, .chip-done::before, .chip-invalid::before, .spec-status::before, .picker-card[data-unready="true"] .picker-card-name::before {
  content: "";
  display: inline-block;
  flex: none;
  width: 8px;
  height: 8px;
  background: currentColor;
}
.status-chip::before { background: transparent; border: 1.5px solid currentColor; border-radius: 50%; box-sizing: border-box; }
.status-chip[data-status="complete"]::before, .chip-done::before, .spec-status::before { background: currentColor; border: 0; border-radius: 50%; }
.status-chip:is([data-status="active"], [data-status="in-progress"])::before { background: currentColor; border: 0; border-radius: 0; transform: rotate(45deg) scale(.85); }
.chip-invalid::before, .spec-status-invalid::before { border-radius: 0; }
.picker-card[data-unready="true"] .picker-card-name::before { margin-right: 7px; background: var(--warn); clip-path: polygon(50% 0, 100% 100%, 0 100%); }

ul.plain { margin: 0; padding: 0; list-style: none; }
ul.plain li { padding: 3px 0; border-bottom: 1px solid var(--border-soft); }
ul.plain li:last-child { border-bottom: 0; }
.chip {
  display: inline-block;
  font-size: .7rem;
  font-family: var(--mono);
  padding: 2px 8px;
  margin: 0 5px 4px 0;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel-soft);
}
.chip-done, .chip-invalid { display: inline-flex; align-items: center; gap: 5px; }
.chip-done { color: var(--done); }
.chip-invalid { color: var(--bad); }
.toast {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  background: var(--done); color: var(--on-accent); border-radius: 8px;
  padding: 6px 14px; font-size: .8rem;
  opacity: 0; transition: opacity .16s; pointer-events: none; z-index: 20;
}
.toast[data-shown="true"] { opacity: 1; }
.toast-report { display: flex; gap: 10px; align-items: center; bottom: 64px; }
.toast-report[data-shown="true"] { pointer-events: auto; }
.toast-report a { color: inherit; font-weight: 700; text-decoration: underline; }
.nav-badge { padding: 1px 6px; border-radius: 999px; background: var(--accent); color: var(--on-accent); font-size: .6rem; font-weight: 750; text-transform: uppercase; }
.reports-layout { display: grid; grid-template-columns: minmax(200px, 280px) 1fr; gap: 12px; min-height: 60vh; }
.reports-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.reports-list button { width: 100%; padding: 8px 10px; text-align: left; font-size: .78rem; }
.reports-list button[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
.reports-list .report-time { display: block; color: var(--muted); font-size: .66rem; }
.reports-main { display: grid; grid-template-rows: auto 1fr; gap: 8px; }
.reports-frame { width: 100%; height: 100%; min-height: 60vh; border: 1px solid var(--border); border-radius: 8px; }

.warnings { border-color: var(--warn); }
.error { border-color: var(--bad); }

.runway-step-badge { padding: 1px 5px; border: 1px solid var(--badge); background: var(--badge-soft); color: var(--badge-text); font-size: .62rem; font-style: normal; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.runway-step-badge-optional { --badge: var(--warn); --badge-soft: var(--warn-soft); --badge-text: var(--warn); }
.runway-step-badge-skill { --badge: var(--what); --badge-soft: var(--what-soft); --badge-text: var(--what); }
.runway-step-badge-openspec { --badge: var(--accent); --badge-soft: var(--accent-soft); --badge-text: var(--text); }
.runway-step-badge-human-in-loop { --badge: var(--why); --badge-soft: var(--why-soft); --badge-text: var(--why); }
.runway-step-badge-human-review { --badge: var(--why); --badge-soft: var(--why-soft); --badge-text: var(--why); }
.runway-step-copy { align-self: start; padding: 5px 8px; border-color: var(--border); background: transparent; color: var(--muted); font-size: .68rem; white-space: nowrap; }
.runway-step-copy:hover { background: var(--accent-soft); color: var(--text); }

/** The compact navigation rail keeps scope, navigation, and status visible together. */
.studio-sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  min-width: 0;
  padding: 18px 14px 16px;
  gap: 18px;
  overflow-y: auto;
}
.sidebar-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sidebar-brand-mark { display: block; flex: none; width: 30px; height: 30px; }
.brand-symbol-color { display: none; }
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) .brand-symbol-color { display: block; }
  :root:not([data-theme="dark"]) .brand-symbol-on-dark { display: none; }
}
:root[data-theme="light"] .brand-symbol-color { display: block; }
:root[data-theme="light"] .brand-symbol-on-dark { display: none; }
.sidebar-brand-copy { display: grid; gap: 1px; min-width: 0; }
.sidebar-brand-copy strong { font-size: .9rem; letter-spacing: -.02em; }
.sidebar-label { color: var(--muted); font-size: .62rem; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
.sidebar-scope { display: grid; gap: 7px; }
.sidebar-scope select { padding: 8px 32px 8px 9px; font-family: var(--mono); font-size: .72rem; }
/** Segmented: one track, the active role raised on the panel surface. */
.role-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: 8px; background: var(--border-soft); }
.role-switch button { width: 100%; padding: 5px 4px; border-color: transparent; border-radius: 6px; background: transparent; color: var(--muted); font-size: .7rem; font-weight: 600; line-height: 1.25; text-align: center; }
.role-switch button:hover { border-color: transparent; background: var(--accent-soft); color: var(--text); }
.role-switch button[aria-pressed="true"] { border-color: var(--border); background: var(--panel); color: var(--text); font-weight: 700; }
.sidebar-nav { display: grid; gap: 14px; }
.sidebar-nav-section { display: grid; gap: 3px; }
.sidebar-nav-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.sidebar-nav button { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 6px 10px; border-color: transparent; border-radius: 7px; background: transparent; font-size: .8rem; }
.sidebar-nav button:hover, .sidebar-nav button[aria-pressed="true"] { border-color: var(--border); background: var(--accent-soft); }
.sidebar-nav button[aria-pressed="true"] { color: var(--text); font-weight: 700; }
/** The stats stack as one column: label left, number right, like the report's key-value rows. */
.sidebar-metrics { display: grid; }
.sidebar-metric { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 5px 2px; border-top: 1px solid var(--border); }
.sidebar-metric:last-child { border-bottom: 1px solid var(--border); }
.sidebar-metric strong { order: 1; font-size: .95rem; font-variant-numeric: tabular-nums; font-weight: 650; line-height: 1.2; }
.sidebar-metric span { color: var(--muted); font-size: .75rem; }
.sidebar-footer { display: grid; gap: 6px; margin-top: auto; }
.sidebar-footer-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sidebar-footer button { width: 100%; padding: 7px 8px; font-size: .72rem; }

/** Specs uses the same full-bleed content treatment as Workflow. */
.specs-intro { display: flex; align-items: flex-end; justify-content: space-between; gap: 28px; margin-bottom: 26px; }
.specs-intro-copy { max-width: 54ch; }
.specs-intro-copy p { margin: 0; color: var(--muted); }
.specs-summary { display: grid; grid-template-columns: repeat(3, minmax(84px, 1fr)); gap: 20px; min-width: 290px; }
.specs-summary-item { display: grid; gap: 2px; padding-top: 10px; border-top: 1px solid var(--border); }
.specs-summary-item strong { font-size: 1.6rem; font-variant-numeric: tabular-nums; font-weight: 650; line-height: 1.2; }
.specs-summary-item span { color: var(--muted); font-size: .8rem; }
/** Factory board: five columns of Workset cards; "your turn" uses the warn tone, the agent's the info tone. */
.factory-board { display: grid; grid-template-columns: repeat(5, minmax(180px, 1fr)); gap: 12px; align-items: start; overflow-x: auto; }
@media (max-width: 900px) { .factory-board { grid-template-columns: 1fr; } }
.factory-column { display: grid; align-content: start; gap: 10px; min-width: 0; padding-top: 10px; border-top: 1px solid var(--border); }
.factory-column h3 { font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.factory-card { display: grid; gap: 4px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); min-width: 0; }
.factory-card[data-turn="human"] { border-color: var(--warn); }
.factory-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.factory-card-title { font-size: .88rem; overflow-wrap: anywhere; }
.factory-card-stage { font-size: .8rem; }
.factory-card-meta { color: var(--muted); font-size: .7rem; overflow-wrap: anywhere; }
.factory-turn { flex: none; font-family: var(--mono); font-size: .64rem; color: var(--info); white-space: nowrap; }
.factory-turn[data-turn="human"] { color: var(--warn); }
.factory-turn[data-turn="none"] { color: var(--done); }
.factory-problems { margin: 4px 0 0; padding-left: 16px; color: var(--warn); font-size: .72rem; }
.factory-card form { margin-top: 6px; }
.factory-run { display: grid; gap: 4px; }
.factory-run-state { color: var(--info); font-size: .74rem; }
.factory-question { margin: 4px 0 0; padding: 6px 8px; border-left: 2px solid var(--warn); font-size: .8rem; }
.factory-action { display: grid; gap: 4px; }
.factory-action textarea { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
.factory-create summary { cursor: pointer; color: var(--accent); font-size: .84rem; }
.factory-create-form { display: grid; grid-template-columns: repeat(3, minmax(140px, 1fr)); gap: 10px; margin-top: 10px; }
.factory-create-form label { display: grid; gap: 4px; font-size: .74rem; color: var(--muted); }
.factory-create-intent { grid-column: 1 / -1; }
.factory-create-form input, .factory-create-form textarea { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
.factory-create-form button { justify-self: start; }

.picker-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(252px, 1fr)); gap: 12px; }
.picker-card { display: grid; align-content: start; gap: 5px; padding: 16px; }
.picker-card[data-unready="true"] { border-color: var(--warn); }
.picker-card-name { overflow: hidden; font-family: var(--mono); font-size: .9rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
.picker-card-path { color: var(--muted); font-size: .72rem; overflow-wrap: anywhere; }
.picker-card-meta { display: flex; flex-wrap: wrap; margin-top: 5px; }

.specs-area-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 14px; }
.specs-area-card { padding: 18px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.specs-area-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border-soft); }
.specs-area-name { min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.specs-area-count { color: var(--muted); font-family: var(--mono); font-size: .7rem; white-space: nowrap; }
.specs-card-list { display: grid; gap: 7px; margin-top: 14px; }
.spec-card-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border-soft); }
.spec-card-row:last-child { border-bottom: 0; padding-bottom: 0; }
.spec-card-row:first-child { padding-top: 0; }
.spec-card-row > div { min-width: 0; }
/** Long capability names wrap at their hyphens instead of running under the actions. */
.spec-card-row strong { display: block; font-family: var(--mono); font-size: .78rem; line-height: 1.35; overflow-wrap: anywhere; }
.spec-card-meta { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: .7rem; }
.spec-card-end { display: inline-flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
.spec-copy { display: inline-flex; align-items: center; align-self: center; padding: 4px 6px; }
.spec-actions { display: inline-flex; gap: 6px; }
.spec-action { padding: 3px 7px; font-size: .68rem; }
html[data-agent-viewed] [data-studio-action] { display: none; }
.spec-status { display: inline-flex; align-items: center; gap: 6px; color: var(--done); font-family: var(--mono); font-size: .61rem; text-transform: uppercase; }
.spec-status-invalid { color: var(--bad); }

/** Business Analyst Overview: published state read at a glance; lists, not tables. */
.analyst-overview { display: grid; gap: 28px; }
.analyst-summary { display: grid; gap: 16px; }
.analyst-summary-head, .analyst-part-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.analyst-summary-head h2 { margin: 0; font-size: 1.05rem; font-weight: 700; letter-spacing: -.02em; }
.analyst-more { font-size: .8rem; text-underline-offset: 3px; }
.analyst-summary-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 28px; align-items: start; }
.analyst-stats { display: grid; grid-template-columns: repeat(3, minmax(84px, 1fr)); gap: 20px; margin: 0; }
.analyst-stat { display: flex; flex-direction: column-reverse; gap: 2px; padding-top: 10px; border-top: 1px solid var(--border); }
.analyst-stat dt { color: var(--muted); font-size: .8rem; }
.analyst-stat dd { margin: 0; font-size: 1.6rem; font-variant-numeric: tabular-nums; font-weight: 650; line-height: 1.2; }
.analyst-stat[data-alert="true"] { border-top-color: var(--bad); }
.analyst-stat[data-alert="true"] dd { color: var(--bad); }
.analyst-areas { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0 20px; margin: 0; padding: 0; list-style: none; }
.analyst-areas li { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; min-width: 0; padding: 7px 0; border-top: 1px solid var(--border-soft); }
.analyst-areas .mono { overflow: hidden; font-size: .78rem; text-overflow: ellipsis; white-space: nowrap; }
.analyst-count { color: var(--muted); font-family: var(--mono); font-size: .72rem; font-variant-numeric: tabular-nums; }
.analyst-grid { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 14px; align-items: start; }
.analyst-side { display: grid; gap: 14px; }
.analyst-part { display: grid; gap: 12px; padding: 18px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.analyst-part-head { padding-bottom: 12px; border-bottom: 1px solid var(--border-soft); }
.analyst-part-note { color: var(--muted); font-family: var(--mono); font-size: .7rem; white-space: nowrap; }
.analyst-list { display: grid; margin: 0; padding: 0; list-style: none; }
.analyst-row { display: grid; gap: 3px; min-width: 0; padding: 9px 0; border-bottom: 1px solid var(--border-soft); }
.analyst-row:first-child { padding-top: 0; }
.analyst-row:last-child { padding-bottom: 0; border-bottom: 0; }
.analyst-row-title { justify-self: start; max-width: 100%; color: var(--text); font-family: var(--mono); font-size: .8rem; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; text-decoration: none; }
.analyst-row-title:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.analyst-row-title:focus-visible, .analyst-more:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
.analyst-report-title { font-family: inherit; font-size: .84rem; }
.analyst-row-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); font-size: .72rem; font-variant-numeric: tabular-nums; }
.analyst-caps { min-width: 0; font-family: var(--mono); overflow-wrap: anywhere; }
@media (max-width: 1100px) { .analyst-summary-body, .analyst-grid { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .analyst-stats { grid-template-columns: 1fr 1fr; } }

.skills-panels > [data-active="false"] { display: none; }
.skills-panel-description { margin: 0 0 16px; color: var(--muted); font-size: .8rem; }
.skills-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.skill-card { display: grid; gap: 4px; min-width: 0; padding: 13px 14px; border: 1px solid var(--border-soft); border-radius: 8px; background: var(--panel-soft); }
.skill-card code { overflow: hidden; font-size: .78rem; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.skill-card span { overflow: hidden; color: var(--muted); font-family: var(--mono); font-size: .65rem; text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 600px) {
  .main { padding-right: 18px; padding-left: 18px; }
  .page-header { display: grid; gap: 18px; }
  .page-context { min-width: 0; max-width: none; }
  .section-header { gap: 10px; }
}

/** Detached panels: the grid column carries the inset so the rail keeps its 224px content width. */
@media (min-width: 901px) {
  .shell:has(.studio-sidebar) { grid-template-columns: calc(224px + var(--sidebar-inset)) minmax(0, 1fr); }
  .studio-sidebar {
    top: var(--sidebar-inset);
    height: calc(100vh - 2 * var(--sidebar-inset));
    margin: var(--sidebar-inset) 0 var(--sidebar-inset) var(--sidebar-inset);
    border: 1px solid var(--border);
    border-radius: var(--sidebar-radius);
  }
}
@media (max-width: 900px) {
  .studio-sidebar {
    position: relative;
    height: auto;
    max-height: none;
    margin: var(--sidebar-inset) var(--sidebar-inset) 0;
    border: 1px solid var(--border);
    border-radius: var(--sidebar-radius);
  }
}

/** Production Workflow Delivery Path. */
.workflow-view { margin: 0 auto; }
.workflow-delivery-path { width: 100%; color: var(--text); }
.workflow-schema-panels > [data-active="false"] { display: none; }
.view-choice { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0; color: var(--muted); font-family: var(--mono); font-size: .66rem; }
.view-choice select { width: auto; max-width: 100%; padding: 6px 32px 6px 10px; border: 1px solid var(--border); border-radius: 6px; background-color: var(--panel-soft); color: var(--text); font: inherit; font-size: .74rem; }
.view-choice select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.view-choice code { color: var(--text); font-size: .74rem; }
.workflow-description { max-width: 70ch; margin: 0; color: var(--muted); font-family: system-ui, sans-serif; font-size: .73rem; line-height: 1.4; }
.workflow-command { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 6px 6px 6px 10px; border-radius: 6px; background: var(--panel-soft); }
.workflow-command-label { color: var(--muted); font-family: var(--mono); font-size: .6rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.workflow-command code { color: var(--text); font-family: var(--mono); font-size: .78rem; overflow-wrap: anywhere; }
.workflow-command .runway-step-copy { align-self: center; border-color: var(--border-soft); }
.workflow-badges { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.workflow-badges .runway-step-badge { font-size: .56rem; }
.workflow-graph-openspec { display: inline-block; flex: none; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: var(--accent); vertical-align: middle; }
.workflow-graph-legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 18px; margin: 0; padding: 0; color: var(--muted); font-family: var(--mono); font-size: .62rem; list-style: none; }
.workflow-graph-legend li { display: inline-flex; align-items: center; gap: 6px; }
.workflow-graph-legend .workflow-graph-openspec { margin-right: 0; }
.workflow-legend-optional { width: 14px; height: 9px; border: 1px dashed var(--muted); border-radius: 3px; }
.workflow-legend-session { width: 7px; height: 7px; border: 1.5px solid var(--accent); border-radius: 50%; }
.workflow-legend-skip { width: 16px; border-top: 1.5px dotted var(--muted); }
/** One column on tablet and phone: graph, then the stage panel. Side by side once both fit. */
.workflow-schema { container-type: inline-size; }
.workflow-path { display: flex; flex-direction: column; gap: 24px; padding-top: 56px; }
/** Room outside the graph for its workset frame. */
.workflow-path-graph { display: grid; justify-items: center; gap: 36px; min-width: 0; }
.workflow-path-graph > .workflow-graph { width: min(100% - 64px, 440px); }
/** The one card on the view: the selected stage, or the path overview. */
.workflow-detail { min-width: 0; padding: 18px 20px 20px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
/* 504px graph + 40px gap + 340px panel: below that the graph would shrink and wrap its labels. */
@container (min-width: 884px) {
  /* Graph and card sit together at the left; 504px holds the graph and its workset frame. */
  .workflow-path { display: grid; grid-template-columns: 504px minmax(340px, 420px); justify-content: start; gap: 40px; align-items: start; }
  /* Top-aligned with the workset frame, which rises 34px above the graph. */
  .workflow-detail { position: sticky; top: 16px; margin-top: -34px; }
}
/** Only the targeted card shows; with none targeted the overview does. */
.workflow-detail .workflow-card { display: none; }
.workflow-detail:has(.workflow-card:target) .workflow-detail-overview { display: none; }
/** Rows are equal and lanes 2fr with a 1fr bypass lane, matching the SVG drawing units. */
.workflow-graph { --graph-gutter: 3.75rem; position: relative; padding-left: var(--graph-gutter); }
.workflow-graph-bands { position: absolute; inset: 0; }
.workflow-graph-band { position: absolute; right: 0; left: 0; padding-top: 7px; color: var(--muted); font-family: var(--mono); font-size: .56rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
/** The workset: the changes published together, framed around the per-change cycle and Publish. */
.workflow-graph-workset { position: absolute; inset: -34px -30px -16px; border: 1px solid var(--muted); border-radius: 16px; }
.workflow-graph-workset span { position: absolute; top: -8px; left: 16px; padding: 0 6px; background: var(--bg); color: var(--text); font-family: var(--mono); font-size: .56rem; font-weight: 700; letter-spacing: .06em; }
/** The stages each change repeats, framed like a fieldset; Publish stays outside. */
.workflow-graph-cycle { position: absolute; right: -14px; left: -14px; box-sizing: content-box; margin-top: -14px; padding-top: 14px; border: 1px dashed var(--why); border-radius: 12px; }
.workflow-graph-cycle span { position: absolute; top: -8px; right: 14px; padding: 0 6px; background: var(--bg); color: var(--why); font-family: var(--mono); font-size: .56rem; font-weight: 700; letter-spacing: .06em; }
.workflow-graph-layer { position: absolute; top: 0; left: var(--graph-gutter); width: calc(100% - var(--graph-gutter)); height: 100%; overflow: visible; pointer-events: none; }
.workflow-graph-edge { fill: none; stroke: var(--muted); stroke-width: 1.25; vector-effect: non-scaling-stroke; }
.workflow-graph-edge[data-edge-kind="bypass"] { stroke-dasharray: 3 4; }
.workflow-graph-edge[data-new-session="true"] { stroke: var(--accent); }
.workflow-graph-start { fill: var(--muted); }
.workflow-graph-session { fill: var(--bg); stroke: var(--accent); stroke-width: 1.5; }
.workflow-graph-nodes { position: relative; display: grid; grid-template-columns: repeat(var(--graph-rows), minmax(0, 2fr)) minmax(0, 1fr); grid-template-rows: repeat(var(--graph-columns), minmax(3.5rem, 1fr)); margin: 0; padding: 0; list-style: none; }
.workflow-graph-node { display: flex; align-items: center; justify-content: center; min-width: 0; padding: 8px 4px; grid-row: var(--graph-row); grid-column: var(--graph-lane) / span var(--graph-span); }
.workflow-graph-box { max-width: 100%; padding: 5px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); }
.workflow-graph-link { display: block; color: var(--text); font-family: var(--mono); font-size: .7rem; line-height: 1.3; text-align: center; text-decoration: none; overflow-wrap: anywhere; transition: border-color .15s, background .15s; }
.workflow-graph-box[data-optional="true"] { border-style: dashed; border-color: var(--muted); }
.workflow-graph-group { display: grid; gap: 3px; padding: 6px 8px; border-color: var(--why); }
.workflow-graph-group-label { color: var(--why); font-family: var(--mono); font-size: .52rem; font-weight: 700; letter-spacing: .08em; text-align: center; text-transform: uppercase; }
.workflow-graph-group ol { display: flex; flex-wrap: wrap; justify-content: center; gap: 2px 4px; margin: 0; padding: 0; list-style: none; }
.workflow-graph-group .workflow-graph-link { padding: 1px 4px; border-radius: 4px; color: var(--why); }
.workflow-graph-link:hover, .workflow-graph-link:focus-visible { border-color: var(--accent); background: var(--accent-soft); }
.workflow-graph-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.workflow-graph-link[aria-current="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
/** Flat stage block: the badges carry optional and human review; the graph carries the shape. */
.workflow-missing-skill { margin: 8px 0 0; color: var(--warn); font-family: system-ui, sans-serif; font-size: .7rem; }
.workflow-detail-overview { display: grid; gap: 8px; }
.workflow-detail-hint { margin: 0; color: var(--text); font-family: system-ui, sans-serif; font-size: .78rem; line-height: 1.5; }
/** Selected stage: header, action, purpose, footer, on one 16px rhythm. */
.workflow-card { min-width: 0; scroll-margin-top: 16px; }
.workflow-detail .workflow-card:target { display: grid; gap: 16px; }
.workflow-card-header { display: grid; gap: 6px; }
.workflow-card-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.workflow-card-heading h3 { margin: 0; color: var(--text); font-family: var(--mono); font-size: .9rem; font-weight: 700; }
.workflow-card-meta { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 0; color: var(--muted); font-family: var(--mono); font-size: .66rem; }
.workflow-card-meta code { font-family: inherit; font-size: inherit; }
/** In the panel a prompt gets its own line under its label and copy control. */
.workflow-detail .workflow-command { grid-template-columns: minmax(0, 1fr) auto; row-gap: 6px; padding: 8px 8px 10px 10px; }
.workflow-detail .workflow-command code { grid-column: 1 / -1; grid-row: 2; font-size: .76rem; line-height: 1.45; overflow-wrap: break-word; }
.workflow-card-session { color: var(--accent); }
.workflow-card-human { margin: 0; padding: 9px 10px; border-radius: 6px; background: var(--panel-soft); color: var(--muted); font-family: system-ui, sans-serif; font-size: .74rem; line-height: 1.45; }
.workflow-card-explanation { display: grid; gap: 12px; margin: 0; }
.workflow-card-explanation dt { margin-bottom: 3px; color: var(--muted); font-family: var(--mono); font-size: .58rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.workflow-card-explanation dd { margin: 0; color: var(--text); font-family: system-ui, sans-serif; font-size: .78rem; line-height: 1.5; }
.workflow-card-explanation div + div dd { color: var(--muted); }
.workflow-card-footer { padding-top: 12px; border-top: 1px solid var(--border-soft); }
.workflow-card-footer a { color: var(--muted); font-size: .72rem; text-underline-offset: 3px; }
.workflow-card-footer a:hover { color: var(--text); }
.workflow-option-list { display: grid; gap: 12px; }
.workflow-option { display: grid; }
.workflow-option .runway-step-copy { justify-self: start; }
.workflow-option small { margin-top: 5px; padding: 0 2px; color: var(--muted); font-size: .7rem; line-height: 1.45; }

.vault-layout { display: grid; grid-template-columns: minmax(220px, 300px) minmax(0, 1fr); gap: 16px; align-items: start; }
:root[data-vault-tree="hidden"] .vault-layout { grid-template-columns: minmax(0, 1fr); }
:root[data-vault-tree="hidden"] .vault-tree-panel { display: none; }
.vault-tree-panel, .vault-main, .vault-editor-panel { min-width: 0; }
.vault-tree-panel { position: sticky; top: 16px; display: grid; gap: 10px; max-height: calc(100vh - 32px); overflow: auto; padding: 12px; }
.vault-tree-head { display: flex; align-items: center; justify-content: space-between; font-size: .86rem; }
.vault-filter { width: 100%; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-soft); color: var(--text); font-size: .8rem; }
.vault-filter:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.vault-tree { display: grid; gap: 1px; }
.vault-icon { position: relative; flex: none; box-sizing: border-box; }
.vault-icon-folder { width: 15px; height: 11px; margin-top: 2px; border-radius: 1px 2px 2px 2px; background: var(--accent); }
.vault-icon-folder::before { content: ""; position: absolute; top: -2px; left: 0; width: 6px; height: 3px; border-radius: 1px 1px 0 0; background: var(--accent); }
.vault-icon-file { width: 11px; height: 14px; margin: 0 2px; border: 1.5px solid var(--muted); border-radius: 1px 4px 1px 1px; }
.vault-chevron { flex: none; box-sizing: border-box; width: 7px; height: 7px; margin: 0 3px; border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted); transform: rotate(-45deg); transition: transform .12s ease; }
.vault-directory[open] > summary .vault-chevron { transform: rotate(45deg); }
.vault-directory > summary { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; list-style: none; color: var(--text); cursor: pointer; font-size: .8rem; }
.vault-directory > summary::-webkit-details-marker { display: none; }
.vault-directory > summary:hover, .vault-directory > summary[aria-current="page"] { background: var(--accent-soft); }
.vault-children { display: grid; gap: 1px; margin-left: 11px; padding-left: 8px; border-left: 1px solid var(--border-soft); }
.vault-directory[hidden] { display: none; }
#vault-tree-panel[data-vault-filtering] [data-vault-slot="tree"] { display: none; }
.vault-tree-head form { margin: 0; }
.vault-file { display: flex; text-decoration: none; align-items: center; gap: 6px; width: 100%; overflow: hidden; padding: 4px 6px 4px 24px; border: 0; border-radius: 6px; background: transparent; color: var(--text); font-size: .8rem; text-align: left; white-space: nowrap; }
.vault-file span, .vault-directory > summary span { overflow: hidden; text-overflow: ellipsis; }
.vault-file:hover { background: var(--accent-soft); }
.vault-file[aria-current="page"] { background: var(--accent-soft); color: var(--text); font-weight: 600; }
.vault-bar { display: flex; align-items: center; gap: 12px; min-height: 36px; margin-bottom: 12px; }
.vault-tree-toggle { flex: none; padding: 5px 10px; font-size: .78rem; }
.vault-breadcrumb ol { display: flex; flex-wrap: wrap; align-items: center; margin: 0; padding: 0; list-style: none; font-size: .95rem; }
.vault-breadcrumb li { display: flex; align-items: center; }
.vault-breadcrumb li + li::before { content: "/"; padding: 0 6px; color: var(--muted); }
.vault-breadcrumb [aria-current="page"] { font-weight: 600; }
.vault-crumb { display: contents; }
.vault-crumb button { padding: 0; border: 0; background: transparent; color: var(--accent); font: inherit; cursor: pointer; }
.vault-crumb button:hover { text-decoration: underline; }
.vault-listing { padding: 0; overflow: hidden; }
.vault-listing > p { margin: 0; padding: 12px 16px; }
.vault-rows { margin: 0; padding: 0; list-style: none; }
.vault-rows li + li { border-top: 1px solid var(--border-soft); }
.vault-row { display: contents; }
.vault-row button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 16px; border: 0; border-radius: 0; background: transparent; color: var(--text); font-size: .86rem; text-align: left; }
.vault-row button:hover { background: var(--panel-soft); }
.vault-row button:hover span { color: var(--accent); text-decoration: underline; }
.vault-warning { color: var(--warn); }
#vault-editor { display: block; width: 100%; min-height: 62vh; resize: vertical; padding: 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--prompt-bg); color: var(--prompt-text); font-family: var(--mono); font-size: .86rem; line-height: 1.6; }
#vault-editor:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
#vault-editor[readonly] { cursor: default; opacity: .85; }
.vault-actions { display: flex; align-items: center; gap: 8px; }
.vault-mode-link { display: inline-block; padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: inherit; font: inherit; text-decoration: none; }
.vault-mode-link:hover { background: var(--panel-soft); color: var(--accent); }
.markdown-body { padding: 4px 2px; line-height: 1.65; overflow-wrap: anywhere; }
.markdown-body > :first-child { margin-top: 0; }
.markdown-body h1, .markdown-body h2 { padding-bottom: .3em; border-bottom: 1px solid var(--border); }
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6 { margin: 1.4em 0 .6em; line-height: 1.25; }
.markdown-body p, .markdown-body ul, .markdown-body ol, .markdown-body blockquote, .markdown-body pre, .markdown-body .md-table { margin: 0 0 1em; }
.markdown-body ul, .markdown-body ol { padding-left: 2em; }
.markdown-body li > ul, .markdown-body li > ol { margin: .25em 0 0; }
.markdown-body li.md-task { list-style: none; margin-left: -1.4em; }
.markdown-body li.md-task input { margin: 0 .5em 0 0; vertical-align: middle; }
.markdown-body blockquote { padding: 0 1em; border-left: .25em solid var(--border); color: var(--muted); }
.markdown-body code { padding: .15em .35em; border-radius: 6px; background: var(--panel-soft); font-family: var(--mono); font-size: .86em; }
.markdown-body pre { overflow: auto; padding: 14px 16px; border: 1px solid var(--border); border-radius: 8px; line-height: 1.5; }
.markdown-body pre code { padding: 0; background: transparent; font-size: .84rem; }
.markdown-body hr { height: 1px; margin: 1.5em 0; border: 0; background: var(--border); }
.markdown-body .md-table { overflow-x: auto; }
.markdown-body table { border-collapse: collapse; }
.markdown-body th, .markdown-body td { padding: 6px 13px; border: 1px solid var(--border); }
.markdown-body th { background: var(--panel-soft); }
.markdown-body .md-raw { color: var(--muted); font-family: var(--mono); font-size: .86rem; white-space: pre-wrap; }
.markdown-body pre.md-fence { background: var(--panel-soft); color: var(--text); }
.md-fence .th-comment, .md-fence .th-meta { color: var(--muted); }
.md-fence .th-keyword, .md-fence .th-operator, .md-fence .th-command { color: var(--info); }
.md-fence .th-string, .md-fence .th-inserted { color: var(--done); }
.md-fence .th-number, .md-fence .th-literal, .md-fence .th-attr { color: var(--warn); }
.md-fence .th-function, .md-fence .th-type, .md-fence .th-tag, .md-fence .th-property, .md-fence .th-selector, .md-fence .th-heading { color: var(--accent); }
.md-fence .th-deleted { color: var(--bad); }
.vault-incoming { display: grid; gap: 8px; margin-top: 16px; padding: 12px; border: 1px solid var(--warn); border-radius: 8px; background: var(--warn-soft); }
.vault-incoming pre { max-height: 220px; overflow: auto; margin: 0; white-space: pre-wrap; font-family: var(--mono); font-size: .78rem; }
@media (max-width: 800px) { .vault-layout { grid-template-columns: 1fr; } .vault-tree-panel { position: static; max-height: 50vh; } }

@media (max-width: 650px) {
        }

@media (max-width: 760px) {
  .lookup-view .scroll { overflow: visible; }
  .lookup-table { display: block; }
  .lookup-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .lookup-table tbody { display: grid; gap: 0; }
  .lookup-table tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 18px; padding: 16px 0; border-bottom: 1px solid var(--border-soft); }
  .lookup-table tr:last-child { border-bottom: 0; }
  .lookup-table td, .lookup-table td:first-child, .lookup-table td:last-child { display: grid; gap: 5px; min-width: 0; padding: 0; border: 0; }
  .lookup-table td::before { color: var(--muted); content: attr(data-label); font-size: .62rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .lookup-table td:first-child, .lookup-table td:last-child { grid-column: 1 / -1; }
  .lookup-table td:first-child::before { display: none; }
  .lookup-table tbody tr:hover td { background: transparent; }
  .lookup-table .bar { width: 100%; max-width: 180px; }
}

/** Agent terminal sidebar: every rule is scoped so a page without the terminal is unchanged. */
.terminal-sidebar {
  --terminal-strip: 44px;
  position: sticky;
  top: 0;
  height: 100vh;
  min-width: 0;
  display: flex;
  background: var(--bg-rail);
  border-left: 1px solid var(--border);
}
.terminal-resize { position: absolute; top: 0; bottom: 0; left: -4px; width: 8px; cursor: col-resize; touch-action: none; z-index: 2; }
.terminal-resize:hover { background: var(--accent-soft); }
.terminal-strip { display: none; flex-direction: column; align-items: center; gap: 12px; width: 100%; padding: 14px 0; }
.terminal-body { display: flex; flex-direction: column; gap: 10px; flex: 1; min-width: 0; min-height: 0; padding: 16px 14px 14px; }
.terminal-head { display: grid; gap: 8px; }
.terminal-title { display: flex; align-items: center; gap: 8px; }
.terminal-title h2 { flex: 1; margin: 0; font-size: 15px; }
.terminal-icon-button { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; font-size: 16px; line-height: 1; text-align: center; }
#terminal-drawer-close { display: none; }
.terminal-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.terminal-sidebar[data-terminal-state="connected"] .terminal-dot { background: var(--done); }
.terminal-sidebar[data-terminal-state="reconnecting"] .terminal-dot { background: var(--warn); }
.terminal-sidebar[data-terminal-state="detached"] .terminal-dot { background: var(--bad); }
.terminal-target { margin: 0; color: var(--muted); font-size: .8rem; overflow-wrap: anywhere; }
.terminal-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.terminal-actions .button { padding: 6px 9px; font-size: .78rem; }
.terminal-choice { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: .78rem; }
.terminal-choice[hidden] { display: none; }
.terminal-choice .button { padding: 6px 9px; font-size: .78rem; }
.terminal-status { margin: 0; color: var(--muted); font-size: 12px; }
.terminal-view { flex: 1; min-height: 160px; background: #000; border-radius: 8px; padding: 6px; overflow: hidden; }
.terminal-sessions-footer { flex: none; display: grid; gap: 6px; max-height: 28vh; overflow-y: auto; }
.terminal-sessions-title { margin: 0; font-size: 12px; color: var(--muted); }
.terminal-sessions { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.terminal-sessions li { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: .75rem; }
.terminal-sessions .button { padding: 4px 8px; font-size: .72rem; }
.terminal-drawer-open { display: none; }

@media (min-width: 1201px) {
  .shell[data-terminal] { grid-template-columns: calc(224px + var(--sidebar-inset)) minmax(0, 1fr) clamp(360px, var(--terminal-width, min(560px, 40vw)), 70vw); }
  :root[data-terminal-collapsed] .shell[data-terminal] { grid-template-columns: calc(224px + var(--sidebar-inset)) minmax(0, 1fr) calc(var(--terminal-strip, 44px) + var(--sidebar-inset)); }
  /** Mirrors the rail; the stored width spans to the window edge, so it includes the inset. */
  .shell[data-terminal] .terminal-sidebar {
    top: var(--sidebar-inset);
    height: calc(100vh - 2 * var(--sidebar-inset));
    margin: var(--sidebar-inset) var(--sidebar-inset) var(--sidebar-inset) 0;
    border: 1px solid var(--border);
    border-radius: var(--sidebar-radius);
  }
  :root[data-terminal-collapsed] .shell[data-terminal] .terminal-body,
  :root[data-terminal-collapsed] .shell[data-terminal] .terminal-resize { display: none; }
  :root[data-terminal-collapsed] .shell[data-terminal] .terminal-strip { display: flex; }
}

/** Below the side-by-side breakpoint the sidebar is an off-canvas drawer; collapse does not apply. */
@media (max-width: 1200px) {
  .shell[data-terminal] .terminal-sidebar {
    position: fixed;
    top: 0;
    right: 0;
    width: min(92vw, clamp(360px, var(--terminal-width, min(560px, 40vw)), 70vw));
    height: 100vh;
    z-index: 30;
    box-shadow: var(--drawer-shadow);
    transform: translateX(100%);
    visibility: hidden;
    transition: transform .2s, visibility .2s;
  }
  .shell[data-terminal] .terminal-sidebar[data-drawer-open] { transform: none; visibility: visible; }
  .shell[data-terminal] #terminal-collapse { display: none; }
  .shell[data-terminal] #terminal-drawer-close { display: grid; }
  .terminal-drawer-open { display: block; position: fixed; right: 18px; bottom: 18px; z-index: 25; box-shadow: var(--drawer-shadow); }
}
`;
