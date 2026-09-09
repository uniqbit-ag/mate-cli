/**
 * Theme-aware by tokens: the Workflow palette is the default, light mode is
 * applied through the system preference or the inline toggle, and explicit
 * theme attributes win over media queries.
 */
export const STUDIO_STYLES = `
:root {
  color-scheme: dark;
  --bg: #0e1116;
  --bg-rail: #12171e;
  --panel: #171d26;
  --panel-soft: #1e2631;
  --border: #303b4a;
  --border-soft: #25303c;
  --text: #f3f6fa;
  --muted: #9aa8b8;
  --accent: #8cc7ff;
  --accent-soft: rgb(140 199 255 / 11%);
  --done: #9ee493;
  --done-soft: rgb(158 228 147 / 12%);
  --warn: #f6c56e;
  --warn-soft: rgb(246 197 110 / 12%);
  --bad: #ff8d87;
  --bad-soft: rgb(255 141 135 / 12%);
  --what: #74d3d8;
  --what-soft: rgb(116 211 216 / 12%);
  --why: #caa8ff;
  --why-soft: rgb(202 168 255 / 14%);
  --prompt-bg: #0a0d12;
  --prompt-text: #dce5f0;
  --shadow: 0 14px 36px rgb(0 0 0 / 22%);
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    color-scheme: light;
    --bg: #f3f6fa;
    --bg-rail: #f8fafc;
    --panel: #ffffff;
    --panel-soft: #eef4fa;
    --border: #cbd5e1;
    --border-soft: #e3eaf2;
    --text: #18212b;
    --muted: #637083;
    --accent: #1f66a6;
    --accent-soft: #e8f3fd;
    --done: #287b3b;
    --done-soft: #e7f5e9;
    --warn: #946300;
    --warn-soft: #fff4d9;
    --bad: #b42318;
    --bad-soft: #ffebe9;
    --what: #176b75;
    --what-soft: #e2f5f6;
    --why: #6346a5;
    --why-soft: #f0ebff;
    --prompt-bg: #17212b;
    --prompt-text: #edf4fb;
    --shadow: 0 12px 32px rgb(30 55 80 / 10%);
  }
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { color-scheme: dark; }
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f3f6fa;
  --bg-rail: #f8fafc;
  --panel: #ffffff;
  --panel-soft: #eef4fa;
  --border: #cbd5e1;
  --border-soft: #e3eaf2;
  --text: #18212b;
  --muted: #637083;
  --accent: #1f66a6;
  --accent-soft: #e8f3fd;
  --done: #287b3b;
  --done-soft: #e7f5e9;
  --warn: #946300;
  --warn-soft: #fff4d9;
  --bad: #b42318;
  --bad-soft: #ffebe9;
  --what: #176b75;
  --what-soft: #e2f5f6;
  --why: #6346a5;
  --why-soft: #f0ebff;
  --prompt-bg: #17212b;
  --prompt-text: #edf4fb;
  --shadow: 0 12px 32px rgb(30 55 80 / 10%);
}
:root[data-theme="dark"] {
  color-scheme: dark;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
.shell { display: grid; grid-template-columns: 260px minmax(0, 1fr); min-height: 100vh; }
@media (max-width: 900px) { .shell { grid-template-columns: 1fr; } }

.rail {
  background: var(--bg-rail);
  border-right: 1px solid var(--border);
  padding: 22px 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.pairings li { padding: 6px 0; font-size: .84rem; }
select, button {
  font: inherit;
  color: inherit;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 11px;
  max-width: 100%;
}
select { width: 100%; }
button { cursor: pointer; text-align: left; transition: border-color .15s, background .15s, color .15s; }
button:hover { border-color: var(--accent); background: var(--accent-soft); }
button:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.main { padding: 40px clamp(22px, 4vw, 64px) 72px; min-width: 0; background: var(--bg); }
.main > * { width: min(100%, 1180px); margin-right: auto; margin-left: auto; }
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 16px;
  box-shadow: var(--shadow);
}
h1 { margin: 0; font-size: clamp(1.75rem, 3vw, 2.25rem); line-height: 1.1; letter-spacing: -.04em; }
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

.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 32px; padding-bottom: 24px; margin-bottom: 18px; border-bottom: 1px solid var(--border-soft); }
.page-heading { min-width: 0; }
.page-eyebrow { margin: 0 0 8px; color: var(--accent); font-family: var(--mono); font-size: .68rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.page-context { display: grid; gap: 6px; min-width: min(100%, 300px); max-width: 380px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }
.page-context-label { color: var(--muted); font-size: .64rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.page-context code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.snapshot-status { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: .75rem; }
.snapshot-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--done); }
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
.section-note { margin: 4px 0 0; color: var(--muted); font-size: .8rem; }
.section-count { flex: none; color: var(--muted); font-family: var(--mono); font-size: .72rem; }

table { border-collapse: collapse; width: 100%; font-size: .88rem; }
th, td { text-align: left; padding: 12px 10px; border-bottom: 1px solid var(--border-soft); vertical-align: top; }
th:first-child, td:first-child { padding-left: 0; }
th:last-child, td:last-child { padding-right: 0; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
tbody tr:hover td { background: var(--accent-soft); }
td.numeric { font-variant-numeric: tabular-nums; white-space: nowrap; }
.lookup-table td:first-child { min-width: 180px; }
.change-cell { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 8px; }
.change-cell .mono { min-width: 0; overflow-wrap: anywhere; }
.progress-label { display: block; }
.bar { display: block; margin-top: 7px; width: 120px; height: 5px; border-radius: 999px; background: var(--border); overflow: hidden; }
.bar-fill { display: block; height: 100%; background: var(--done); }
.artifact-list { display: flex; flex-wrap: wrap; gap: 5px 6px; }
.lookup-table .chip { margin: 0; padding: 2px 7px; font-size: .68rem; }
.status-chip { display: inline-block; padding: 3px 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--panel-soft); color: var(--muted); font-family: var(--mono); font-size: .68rem; white-space: nowrap; }
.status-chip[data-status="complete"] { border-color: var(--done); background: var(--done-soft); color: var(--done); }
.status-chip[data-status="active"] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }

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
.chip-done { background: var(--done-soft); border-color: var(--done); color: var(--done); }
.chip-invalid { background: var(--bad-soft); border-color: var(--bad); color: var(--bad); }
.toast {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  background: var(--done); color: #0e1116; border-radius: 8px;
  padding: 6px 14px; font-size: .8rem;
  opacity: 0; transition: opacity .16s; pointer-events: none; z-index: 20;
}
.toast[data-shown="true"] { opacity: 1; }

.warnings { border-color: var(--warn); }
.error { border-color: var(--bad); }

.runway-step-badge { padding: 1px 5px; border: 1px solid var(--badge); background: var(--badge-soft); color: var(--badge); font-size: .62rem; font-style: normal; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.runway-step-badge-optional { --badge: var(--warn); --badge-soft: var(--warn-soft); }
.runway-step-badge-skill { --badge: var(--what); --badge-soft: var(--what-soft); }
.runway-step-badge-openspec { --badge: var(--accent); --badge-soft: var(--accent-soft); }
.runway-step-badge-human-in-loop { --badge: var(--why); --badge-soft: var(--why-soft); }
.runway-step-copy { align-self: start; padding: 5px 8px; border-color: var(--border); background: transparent; color: var(--muted); font-size: .68rem; white-space: nowrap; }
.runway-step-copy:hover { background: var(--accent-soft); color: var(--text); }
.workflow-session-break { display: grid; grid-template-columns: minmax(20px, 1fr) auto minmax(20px, 1fr); align-items: center; gap: 10px; padding: 9px 0; color: var(--muted); font-family: var(--mono); font-size: .63rem; letter-spacing: .04em; text-align: center; }
.workflow-session-break::before, .workflow-session-break::after { height: 1px; background: var(--border); content: ""; }

/** The compact navigation rail keeps scope, navigation, and status visible together. */
.studio-sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  min-width: 0;
  padding: 22px 18px 24px;
  gap: 26px;
  overflow-y: auto;
}
.sidebar-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sidebar-brand-mark { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; background: var(--accent); color: var(--bg-rail); font-size: .72rem; font-weight: 800; }
.sidebar-brand-copy { display: grid; gap: 1px; min-width: 0; }
.sidebar-brand-copy strong { font-size: .9rem; letter-spacing: -.02em; }
.sidebar-brand-copy span { color: var(--muted); font-size: .68rem; }
.sidebar-label { color: var(--muted); font-size: .62rem; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
.sidebar-scope { display: grid; gap: 7px; }
.sidebar-scope select { padding: 8px 9px; font-family: var(--mono); font-size: .72rem; }
.sidebar-pairings { color: var(--muted); font-family: var(--mono); font-size: .67rem; line-height: 1.45; }
.sidebar-pairings .plain li { padding: 4px 0; }
.sidebar-pairings .muted { font-size: .67rem; }
.sidebar-nav { display: grid; gap: 3px; }
.sidebar-nav-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.sidebar-nav button { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 8px 10px; border-color: transparent; border-radius: 7px; background: transparent; font-size: .8rem; }
.sidebar-nav button:hover, .sidebar-nav button[aria-pressed="true"] { border-color: var(--border); background: var(--accent-soft); }
.sidebar-nav button[aria-pressed="true"] { color: var(--accent); font-weight: 700; }
.sidebar-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
.sidebar-metric { display: grid; gap: 1px; padding: 8px 6px; border: 1px solid var(--border-soft); border-radius: 7px; background: var(--panel-soft); }
.sidebar-metric strong { font-size: .9rem; font-variant-numeric: tabular-nums; }
.sidebar-metric span { color: var(--muted); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; }
.sidebar-footer { display: grid; gap: 6px; margin-top: auto; }
.sidebar-footer-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sidebar-footer button { width: 100%; padding: 7px 8px; font-size: .72rem; }

/** Specs uses the same full-bleed content treatment as Workflow. */
.specs-eyebrow { color: var(--accent); font-size: .68rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.specs-intro { display: flex; align-items: flex-end; justify-content: space-between; gap: 28px; margin-bottom: 26px; }
.specs-intro-copy { max-width: 54ch; }
.specs-intro-copy p { margin: 0; color: var(--muted); }
.specs-summary { display: grid; grid-template-columns: repeat(3, minmax(84px, 1fr)); min-width: 290px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.specs-summary-item { display: grid; gap: 1px; padding: 12px 10px; border-right: 1px solid var(--border); }
.specs-summary-item:last-child { border-right: 0; }
.specs-summary-item strong { font-size: 1.25rem; font-variant-numeric: tabular-nums; }
.specs-summary-item span { color: var(--muted); font-size: .62rem; text-transform: uppercase; letter-spacing: .08em; }
.picker-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(252px, 1fr)); gap: 12px; }
.picker-card { display: grid; align-content: start; gap: 5px; padding: 16px; }
.picker-card[data-unready="true"] { border-color: var(--warn); }
.picker-card-name { overflow: hidden; font-family: var(--mono); font-size: .9rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
.picker-card-path { color: var(--muted); font-size: .72rem; overflow-wrap: anywhere; }
.picker-card-meta { display: flex; flex-wrap: wrap; margin-top: 5px; }

.specs-area-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 14px; }
.specs-area-card { padding: 18px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }
.specs-area-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; min-height: 58px; padding-bottom: 16px; border-bottom: 1px solid var(--border-soft); }
.specs-area-number { color: var(--muted); font-family: var(--mono); font-size: .68rem; }
.specs-area-name { display: flex; align-items: baseline; gap: 9px; min-width: 0; }
.specs-area-name h4 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.specs-area-count { color: var(--muted); font-family: var(--mono); font-size: .7rem; white-space: nowrap; }
.specs-card-list { display: grid; gap: 7px; margin-top: 14px; }
.spec-card-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border-soft); }
.spec-card-row:last-child { border-bottom: 0; padding-bottom: 0; }
.spec-card-row:first-child { padding-top: 0; }
.spec-card-row strong { overflow: hidden; font-family: var(--mono); font-size: .78rem; text-overflow: ellipsis; white-space: nowrap; }
.spec-card-meta { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: .7rem; }
.spec-status { padding: 2px 5px; border: 1px solid var(--done); background: var(--done-soft); color: var(--done); font-family: var(--mono); font-size: .61rem; text-transform: uppercase; }
.spec-status-invalid { border-color: var(--bad); background: var(--bad-soft); color: var(--bad); }

.skills-tab-list { display: flex; gap: 5px; border-bottom: 1px solid var(--border); }
.skills-tab-list button { display: grid; gap: 3px; min-width: 150px; padding: 10px 12px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--muted); }
.skills-tab-list button:hover { background: var(--accent-soft); }
.skills-tab-list button[aria-selected="true"] { border-bottom-color: var(--accent); background: var(--panel-soft); color: var(--text); }
.skills-tab-list button strong { font-family: var(--mono); font-size: .74rem; text-align: left; }
.skills-tab-list button span { font-size: .68rem; text-align: left; }
.skills-panels { padding-top: 18px; }
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
  .skills-tab-list button { min-width: 0; flex: 1; }
}

@media (min-width: 901px) {
  .shell:has(.studio-sidebar) { grid-template-columns: 260px minmax(0, 1fr); }
}
@media (max-width: 900px) {
  .studio-sidebar { position: relative; height: auto; max-height: none; }
}

/** Production Workflow transcript. */
.workflow-view { margin: 0 auto; }
.workflow-eyebrow { margin: 0 0 10px; color: var(--muted); font-family: var(--mono); font-size: .68rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.workflow-console { width: 100%; overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); color: var(--text); box-shadow: none; }
.workflow-console-header { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--border); background: var(--panel-soft); color: var(--muted); font-family: system-ui, sans-serif; font-size: .68rem; }
.workflow-console-header-title { display: grid; gap: 2px; }
.workflow-console-header-title > span { color: var(--accent); font-family: var(--mono); font-size: .62rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.workflow-console-header-title strong { color: var(--text); font-size: .84rem; }
.workflow-console-header > span:last-child { text-align: right; }
.workflow-console-body { padding: 22px clamp(14px, 3vw, 34px) 26px; }
.workflow-console-context { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px 18px; align-items: start; margin: 4px 0 18px 55px; padding: 11px 0 15px; border-bottom: 1px solid var(--border); }
.workflow-console-context > span { color: var(--why); font-family: var(--mono); font-size: .62rem; text-transform: uppercase; }
.workflow-console-context > div { display: grid; gap: 3px; }
.workflow-console-context p { margin: 0; color: var(--text); font-family: system-ui, sans-serif; font-size: .72rem; line-height: 1.35; }
.workflow-console-context small { color: var(--muted); font-family: system-ui, sans-serif; font-size: .68rem; line-height: 1.35; }
.workflow-console-tabs { display: flex; gap: 5px; margin-left: 55px; border-bottom: 1px solid var(--border); }
.workflow-console-tabs button { display: grid; gap: 3px; min-width: 150px; padding: 10px 12px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); }
.workflow-console-tabs button:hover { background: var(--panel); }
.workflow-console-tabs button[aria-selected="true"] { border-bottom-color: var(--accent); background: var(--panel); color: var(--text); }
.workflow-console-tabs button strong { font-family: var(--mono); font-size: .72rem; text-align: left; }
.workflow-console-tabs button small { font-size: .65rem; text-align: left; }
.workflow-console-panels { margin-left: 20px; padding-left: 35px; border-left: 1px dashed var(--border); }
.workflow-console-panels > [data-active="false"] { display: none; }
.workflow-console-branch-rule { display: grid; gap: 4px; padding: 16px 0 6px; }
.workflow-console-branch-rule-description { max-width: 70ch; margin: 0; color: var(--muted); font-family: system-ui, sans-serif; font-size: .73rem; line-height: 1.4; }
.workflow-console-line { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 13px; padding: 12px 0; }
.workflow-console-gutter { color: var(--muted); font-family: var(--mono); font-size: .66rem; opacity: .7; }
.workflow-console-line-body { min-width: 0; }
.workflow-console-step-title { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-bottom: 7px; }
.workflow-console-step-title strong { color: var(--text); font-family: var(--mono); font-size: .71rem; }
.workflow-console-command { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 9px; align-items: center; padding: 9px 10px; border: 1px solid var(--border-soft); border-radius: 7px; background: var(--panel-soft); }
.workflow-console-command-label { color: var(--accent); font-family: var(--mono); font-size: .62rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.workflow-console-command code { color: var(--text); font-family: var(--mono); font-size: .78rem; overflow-wrap: anywhere; }
.workflow-console-command .runway-step-copy { border-color: var(--border); }
.workflow-console-explanation { display: grid; gap: 6px; margin-top: 10px; }
.workflow-console-detail { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 10px; align-items: baseline; }
.workflow-console-detail > span { color: var(--muted); font-family: var(--mono); font-size: .6rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.workflow-badges { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.workflow-badges .runway-step-badge { font-size: .56rem; }
.workflow-console-explanation p, .workflow-console-explanation small { margin: 0; color: var(--muted); font-family: system-ui, sans-serif; font-size: .73rem; line-height: 1.4; }
.workflow-console-explanation p { color: var(--text); }
.workflow-console-divider { display: flex; align-items: center; gap: 12px; padding: 16px 0 4px 55px; color: var(--accent); font-family: var(--mono); font-size: .63rem; text-transform: uppercase; }
.workflow-console-divider::after { flex: 1; height: 1px; background: var(--border); content: ""; }
.workflow-option-list { display: grid; gap: 3px; margin: 8px 0 0 18px; }
.workflow-option { display: grid; gap: 1px; padding-left: 8px; border-left: 2px solid var(--why); }
.workflow-option small { color: var(--muted); font-size: .65rem; line-height: 1.35; }
.workflow-option .runway-step-copy { justify-self: start; }

@media (max-width: 650px) {
  .workflow-console-header { grid-template-columns: 1fr auto; }
  .workflow-console-context, .workflow-console-tabs { margin-left: 0; }
  .workflow-console-context { grid-template-columns: minmax(0, 1fr); }
  .workflow-console-context > span { margin-bottom: 2px; }
  .workflow-console-tabs button { min-width: 0; flex: 1; padding-right: 8px; padding-left: 8px; }
  .workflow-console-panels { margin-left: 0; padding-left: 10px; }
  .workflow-console-command { grid-template-columns: auto minmax(0, 1fr); }
  .workflow-console-command .runway-step-copy { grid-column: 2; justify-self: start; }
  .workflow-console-divider, .workflow-console .workflow-session-break { padding-left: 0; margin-left: 0; }
}

@media (max-width: 760px) {
  .lookup-panel .scroll { overflow: visible; }
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
`;
