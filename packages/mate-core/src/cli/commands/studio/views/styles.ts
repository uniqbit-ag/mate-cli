/**
 * Theme-aware by tokens: the Workflow palette is the default, light mode is
 * applied through the system preference or the inline toggle, and explicit
 * theme attributes win over media queries.
 */
export const STUDIO_STYLES = `
:root {
  color-scheme: dark;
  --bg: #11141a;
  --bg-rail: #151a21;
  --panel: #181d24;
  --panel-soft: #1f252e;
  --border: #3a424f;
  --border-soft: #2c333e;
  --text: #f0f3f7;
  --muted: #9ca6b4;
  --accent: #c6f36b;
  --accent-soft: rgb(198 243 107 / 10%);
  --done: #c6f36b;
  --done-soft: rgb(198 243 107 / 10%);
  --warn: #ffc86a;
  --warn-soft: rgb(255 200 106 / 12%);
  --bad: #ff817e;
  --bad-soft: rgb(255 129 126 / 12%);
  --what: #8ad7f0;
  --what-soft: rgb(138 215 240 / 12%);
  --why: #d5b3ff;
  --why-soft: rgb(213 179 255 / 14%);
  --prompt-bg: #0b0e13;
  --prompt-text: #dce3ed;
  --shadow: 0 12px 32px rgb(0 0 0 / 18%);
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    color-scheme: light;
    --bg: #f4f6ef;
    --bg-rail: #fbfcf8;
    --panel: #ffffff;
    --panel-soft: #edf2e3;
    --border: #b9c3af;
    --border-soft: #dfe6d7;
    --text: #1a2118;
    --muted: #687165;
    --accent: #637d21;
    --accent-soft: #eff5dc;
    --done: #637d21;
    --done-soft: #eff5dc;
    --warn: #996000;
    --warn-soft: #fff3d8;
    --bad: #b3261e;
    --bad-soft: #fdecec;
    --what: #1a6a85;
    --what-soft: #e3f1f7;
    --why: #64459f;
    --why-soft: #efe9fb;
    --prompt-bg: #1a2118;
    --prompt-text: #edf2e3;
    --shadow: 0 10px 28px rgb(26 33 24 / 8%);
  }
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #11141a;
    --bg-rail: #151a21;
    --panel: #181d24;
    --panel-soft: #1f252e;
    --border: #3a424f;
    --border-soft: #2c333e;
    --text: #f0f3f7;
    --muted: #9ca6b4;
    --accent: #c6f36b;
    --accent-soft: rgb(198 243 107 / 10%);
    --done: #c6f36b;
    --done-soft: rgb(198 243 107 / 10%);
    --warn: #ffc86a;
    --warn-soft: rgb(255 200 106 / 12%);
    --bad: #ff817e;
    --bad-soft: rgb(255 129 126 / 12%);
    --what: #8ad7f0;
    --what-soft: rgb(138 215 240 / 12%);
    --why: #d5b3ff;
    --why-soft: rgb(213 179 255 / 14%);
    --prompt-bg: #0b0e13;
    --prompt-text: #dce3ed;
    --shadow: 0 12px 32px rgb(0 0 0 / 18%);
  }
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f4f6ef;
  --bg-rail: #fbfcf8;
  --panel: #ffffff;
  --panel-soft: #edf2e3;
  --border: #b9c3af;
  --border-soft: #dfe6d7;
  --text: #1a2118;
  --muted: #687165;
  --accent: #637d21;
  --accent-soft: #eff5dc;
  --done: #637d21;
  --done-soft: #eff5dc;
  --warn: #996000;
  --warn-soft: #fff3d8;
  --bad: #b3261e;
  --bad-soft: #fdecec;
  --what: #1a6a85;
  --what-soft: #e3f1f7;
  --why: #64459f;
  --why-soft: #efe9fb;
  --prompt-bg: #1a2118;
  --prompt-text: #edf2e3;
  --shadow: 0 10px 28px rgb(26 33 24 / 8%);
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #11141a;
  --bg-rail: #151a21;
  --panel: #181d24;
  --panel-soft: #1f252e;
  --border: #3a424f;
  --border-soft: #2c333e;
  --text: #f0f3f7;
  --muted: #9ca6b4;
  --accent: #c6f36b;
  --accent-soft: rgb(198 243 107 / 10%);
  --done: #c6f36b;
  --done-soft: rgb(198 243 107 / 10%);
  --warn: #ffc86a;
  --warn-soft: rgb(255 200 106 / 12%);
  --bad: #ff817e;
  --bad-soft: rgb(255 129 126 / 12%);
  --what: #8ad7f0;
  --what-soft: rgb(138 215 240 / 12%);
  --why: #d5b3ff;
  --why-soft: rgb(213 179 255 / 14%);
  --prompt-bg: #0b0e13;
  --prompt-text: #dce3ed;
  --shadow: 0 12px 32px rgb(0 0 0 / 18%);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.5;
  letter-spacing: -.01em;
}
.shell { display: grid; grid-template-columns: 300px 1fr; min-height: 100vh; }
@media (max-width: 900px) { .shell { grid-template-columns: 1fr; } }

.rail {
  background: var(--bg-rail);
  border-right: 1px solid var(--border);
  padding: 22px 20px 32px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.pairings li { padding: 6px 0; font-size: .84rem; }
select, button {
  font: inherit;
  color: inherit;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 0;
  padding: 8px 10px;
  max-width: 100%;
}
select { width: 100%; }
button { cursor: pointer; text-align: left; }
button:hover { border-color: var(--accent); background: var(--accent-soft); }
button:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.main { padding: 26px 28px 60px; min-width: 0; background: var(--bg); }
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 0;
  padding: 20px 22px;
  margin-bottom: 20px;
  box-shadow: none;
}
h3 { color: var(--accent); font-size: .7rem; font-weight: 800; margin: 0 0 14px; letter-spacing: .14em; text-transform: uppercase; }
h4 { font-size: .86rem; margin: 0 0 6px; font-family: var(--mono); }
.note { color: var(--muted); font-size: .82rem; margin: -4px 0 12px; }
.muted { color: var(--muted); font-size: .84rem; }
.mono { font-family: var(--mono); font-size: .86rem; }
.empty { color: var(--muted); font-style: italic; margin: 0; }
.unready { color: var(--warn); }
option.unready { color: var(--warn); font-style: italic; }
option.placeholder { color: var(--muted); font-style: italic; }
.scroll { overflow-x: auto; }

table { border-collapse: collapse; width: 100%; font-size: .88rem; }
th, td { text-align: left; padding: 10px; border-bottom: 1px solid var(--border-soft); vertical-align: top; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
tbody tr:hover td { background: var(--accent-soft); }
td.numeric { font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar { display: block; margin-top: 5px; width: 92px; height: 5px; border-radius: 0; background: var(--border); overflow: hidden; }
.bar-fill { display: block; height: 100%; background: var(--done); }

ul.plain { margin: 0; padding: 0; list-style: none; }
ul.plain li { padding: 3px 0; border-bottom: 1px solid var(--border-soft); }
ul.plain li:last-child { border-bottom: 0; }
.chip {
  display: inline-block;
  font-size: .7rem;
  font-family: var(--mono);
  padding: 2px 8px;
  margin: 0 5px 4px 0;
  border-radius: 0;
  border: 1px solid var(--border);
  background: var(--panel-soft);
}
.chip-done { background: var(--done-soft); border-color: var(--done); color: var(--done); }
.chip-invalid { background: var(--bad-soft); border-color: var(--bad); color: var(--bad); }
.toast {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  background: var(--done); color: #11141a; border-radius: 0;
  padding: 6px 14px; font-size: .8rem;
  opacity: 0; transition: opacity .16s; pointer-events: none; z-index: 20;
}
.toast[data-shown="true"] { opacity: 1; }

.warnings { border-color: var(--warn); }
.error { border-color: var(--bad); }

.workflow-runway { --workflow-accent: var(--accent); max-width: none; margin: -26px -28px -60px; min-height: calc(100vh - 86px); padding: 34px clamp(22px, 5vw, 70px) 70px; background: var(--bg); color: var(--text); }
.workflow-eyebrow { color: var(--workflow-accent); font-size: .68rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.workflow-subtle { color: var(--muted); font-size: .82rem; }
.runway-header { margin-bottom: 26px; }
.runway-header h2 { margin: 0; font-size: clamp(2rem, 5vw, 3.8rem); letter-spacing: -.08em; line-height: .9; }
.runway-track { border: 1px solid var(--border); background: var(--panel); padding: 20px; }
.runway-track-head { display: flex; justify-content: space-between; gap: 12px; padding-bottom: 11px; border-bottom: 1px solid var(--border); }
.runway-step { display: grid; grid-template-columns: 42px minmax(0, 1fr) auto; gap: 14px; width: 100%; min-height: 112px; padding: 16px 0; border: 0; border-bottom: 1px solid var(--border-soft); border-radius: 0; background: transparent; color: inherit; text-align: left; }
.runway-step:last-child { border-bottom: 0; }
.runway-step-index { color: var(--workflow-accent); font-family: var(--mono); font-size: .76rem; }
.runway-step-main { display: grid; gap: 6px; min-width: 0; }
.runway-step-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.runway-step-title > strong { font-size: .95rem; }
.runway-step-badge { padding: 1px 5px; border: 1px solid var(--badge); background: var(--badge-soft); color: var(--badge); font-size: .62rem; font-style: normal; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.runway-step-badge-optional { --badge: var(--warn); --badge-soft: var(--warn-soft); }
.runway-step-badge-skill { --badge: var(--what); --badge-soft: var(--what-soft); }
.runway-step-badge-openspec { --badge: var(--accent); --badge-soft: var(--accent-soft); }
.runway-step-badge-human-in-loop { --badge: var(--why); --badge-soft: var(--why-soft); }
.runway-step-main > span { color: var(--muted); font-size: .76rem; }
.runway-step-facets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; max-width: 108ch; }
.runway-step-facet { display: grid; gap: 2px; padding: 8px 10px; border: 1px solid var(--facet); border-left-width: 3px; background: var(--facet-soft); }
.runway-step-facet > strong { color: var(--facet); font-size: .6rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.runway-step-facet > span { color: var(--text); font-size: .74rem; }
.runway-step-what { --facet: var(--what); --facet-soft: var(--what-soft); }
.runway-step-why { --facet: var(--why); --facet-soft: var(--why-soft); }
.workflow-prompt-label { color: var(--workflow-accent); font-size: .6rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.runway-step-prompt { display: grid; gap: 5px; }
.runway-step-prompt pre { margin: 0; padding: 9px 11px; overflow: auto; border-left: 3px solid var(--workflow-accent); background: var(--panel-soft); white-space: pre-wrap; }
.runway-step-prompt code { color: var(--text); font-family: var(--mono); font-size: .72rem; line-height: 1.45; overflow-wrap: anywhere; white-space: pre-wrap; }
.runway-step-copy { align-self: start; padding: 5px 8px; border-color: var(--border); background: transparent; color: var(--muted); font-size: .68rem; white-space: nowrap; }
.runway-step-copy:hover { background: var(--accent-soft); color: var(--text); }
.workflow-alternatives { display: grid; gap: 8px; }
.workflow-alternative { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 8px; padding: 8px; border: 1px solid var(--border-soft); background: var(--panel); }
.workflow-alternative-copy { display: grid; gap: 2px; min-width: 0; }
.workflow-alternative-copy strong { color: var(--text); font-family: var(--mono); font-size: .72rem; }
.workflow-alternative-copy small { color: var(--muted); font-size: .7rem; }
.workflow-alternative pre { grid-column: 1 / -1; }
.workflow-alternative .runway-step-copy { grid-column: 2; grid-row: 1; }
.workflow-skip { margin: 3px 0 0; color: var(--muted); font-size: .7rem; }
.workflow-flow { display: grid; gap: 0; }
.workflow-connector { position: relative; display: block; width: 1px; height: 22px; margin: 0 auto; background: var(--border); }
.workflow-connector::after { position: absolute; bottom: 0; left: -3px; width: 0; height: 0; border-top: 5px solid var(--border); border-right: 3px solid transparent; border-left: 3px solid transparent; content: ""; }
.workflow-session-break { display: grid; grid-template-columns: minmax(20px, 1fr) auto minmax(20px, 1fr); align-items: center; gap: 10px; padding: 9px 0; color: var(--muted); font-family: var(--mono); font-size: .63rem; letter-spacing: .04em; text-align: center; }
.workflow-session-break::before, .workflow-session-break::after { height: 1px; background: var(--border); content: ""; }
.workflow-choice { padding: 18px; border: 1px solid var(--border); background: var(--panel-soft); }
.workflow-switch-head { display: grid; gap: 6px; max-width: 64ch; }
.workflow-switch-head p { margin: 0; color: var(--muted); font-size: .78rem; }
.workflow-switch-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 16px 0 18px; padding: 0; border: 0; }
.workflow-switch-options legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.workflow-switch-option { display: block; cursor: pointer; }
.workflow-switch-option > input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.workflow-switch-option > span { display: grid; gap: 4px; height: 100%; padding: 11px 12px; border: 1px solid var(--border); background: var(--panel); }
.workflow-switch-option > input:checked + span { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 3px 0 var(--accent); }
.workflow-switch-option strong { font-family: var(--mono); font-size: .78rem; }
.workflow-switch-option small { color: var(--muted); font-size: .72rem; line-height: 1.35; }
.workflow-branch { padding: 0 12px 10px; border: 1px solid var(--border); background: var(--panel); }
.workflow-branch[data-active="false"] { display: none; }
.workflow-branch-head { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0 2px; }
.workflow-branch-step { display: block; }
.workflow-branch-step .runway-step { min-height: 96px; }
.workflow-shared-step { display: block; }
.workflow-shared-step .runway-step { margin-top: 0; padding-right: 12px; padding-left: 12px; border: 1px solid var(--border); background: var(--panel-soft); }
.workflow-finish { padding-bottom: 6px; border-bottom: 0; }

/** The compact navigation rail keeps scope, navigation, and status visible together. */
.studio-sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  min-width: 0;
  padding: 16px 12px;
  gap: 18px;
  overflow-y: auto;
}
.sidebar-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.sidebar-brand-mark { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 0; background: var(--text); color: var(--bg-rail); font-size: .72rem; font-weight: 800; }
.sidebar-brand-copy { display: grid; min-width: 0; }
.sidebar-brand-copy strong { font-size: .88rem; letter-spacing: -.02em; }
.sidebar-label { color: var(--muted); font-size: .62rem; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
.sidebar-scope { display: grid; gap: 7px; }
.sidebar-scope select { border-radius: 0; padding: 7px 8px; font-family: var(--mono); font-size: .72rem; }
.sidebar-pairings { color: var(--muted); font-family: var(--mono); font-size: .67rem; line-height: 1.45; }
.sidebar-pairings .plain li { padding: 4px 0; }
.sidebar-pairings .muted { font-size: .67rem; }
.sidebar-nav { display: grid; gap: 3px; }
.sidebar-nav-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.sidebar-nav button { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 7px 8px; border-color: transparent; border-radius: 0; background: transparent; font-size: .78rem; }
.sidebar-nav button:hover, .sidebar-nav button[aria-pressed="true"] { border-color: var(--border); background: var(--accent-soft); }
.sidebar-nav button[aria-pressed="true"] { color: var(--accent); font-weight: 700; }
.sidebar-metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px; }
.sidebar-metric { display: grid; gap: 1px; padding: 7px; border: 1px solid var(--border-soft); border-radius: 0; background: var(--panel-soft); }
.sidebar-metric strong { font-size: .9rem; font-variant-numeric: tabular-nums; }
.sidebar-metric span { color: var(--muted); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; }
.sidebar-footer { display: grid; gap: 6px; margin-top: auto; }
.sidebar-footer-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sidebar-footer button { width: 100%; padding: 6px 8px; border-radius: 0; font-size: .72rem; }

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
.specs-area-card { position: relative; padding: 18px; border: 1px solid var(--border); background: var(--panel); }
.specs-area-card::before { position: absolute; top: 0; left: 0; width: 32px; height: 3px; background: var(--accent); content: ""; }
.specs-area-card:hover { border-color: var(--accent); }
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

@media (max-width: 600px) {
  .main { padding-right: 18px; padding-left: 18px; }
}

@media (min-width: 901px) {
  .shell:has(.studio-sidebar) { grid-template-columns: 244px 1fr; }
}
@media (max-width: 900px) {
  .studio-sidebar { position: relative; height: auto; max-height: none; }
  .workflow-runway { margin: -26px -20px -60px; }
}
@media (max-width: 600px) {
  .runway-step { grid-template-columns: 30px minmax(0, 1fr); gap: 9px; }
  .runway-step-facets { grid-template-columns: minmax(0, 1fr); }
  .runway-step-copy { grid-column: 2; justify-self: start; }
  .workflow-alternative { grid-template-columns: minmax(0, 1fr); }
  .workflow-alternative .runway-step-copy { grid-column: 1; grid-row: auto; }
  .workflow-choice { padding: 14px; }
  .workflow-switch-options { grid-template-columns: minmax(0, 1fr); }
  .workflow-branch { padding-right: 8px; padding-left: 8px; }
  .workflow-shared-step .runway-step { padding-right: 8px; padding-left: 8px; }
}
`;
