/** @jsxImportSource hono/jsx */

import { companionDigest, FILE_PARAM, REFRESH_PARAM, type StudioSelection } from "../selection";
import { STUDIO_CLIENT_SCRIPT, STUDIO_PREPAINT_SCRIPT } from "./client";
import { CompanionPicker } from "./companion-picker";
import { CompanionSelector } from "./companion-selector";
import { Dashboard } from "./dashboard/index";
import { CompanionError } from "./error";
import { formatCollectedAt, type StudioPage, type StudioVaultPage } from "./model";
import type { VaultTreeNode } from "../vault";
import { Specs } from "./specs/index";
import { STUDIO_STYLES } from "./styles";
import { Skills } from "./skills/index";
import { Workflow } from "./workflow/index";

const STUDIO_TITLE = "Mate Studio";

const VIEW_DETAILS = {
  dashboard: {
    eyebrow: "Companion lookup",
    title: "Overview",
  },
  specs: {
    eyebrow: "Companion lookup",
    title: "Specs",
  },
  workflow: {
    eyebrow: "Companion lookup",
    title: "Workflow",
  },
  skills: {
    eyebrow: "Agent guidance",
    title: "Skills",
  },
  vault: {
    eyebrow: "Companion files",
    title: "Vault",
  },
} as const;

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

/**
 * `data-companion` names the resolved companion only: the browser stores what
 * it can be served again, never a digest the server just failed to resolve.
 */
function StudioShell({ page }: { page: StudioPage }) {
  return (
    <>
      <div
        className="shell"
        data-companion={page.companion ? companionDigest(page.companion.path) : undefined}
      >
        <Sidebar page={page} />
        <main className="main">
          {page.companion ? <PageHeader page={page} /> : null}
          <Content page={page} />
        </main>
      </div>
      <div className="toast" id="studio-toast" data-shown="false" />
    </>
  );
}

function Content({ page }: { page: StudioPage }) {
  if (!page.companion) {
    return <CompanionPicker inventory={page.inventory} selection={page.selection} />;
  }
  if (page.error) {
    return <CompanionError companionPath={page.error.companionPath} reason={page.error.reason} />;
  }
  if (page.selection.view === "vault") return <Vault page={page} />;
  if (!page.payload) {
    return (
      <section className="panel">
        <p className="empty">No state collected for this companion.</p>
      </section>
    );
  }
  if (page.selection.view === "workflow") {
    return <Workflow payload={page.payload} />;
  }
  if (page.selection.view === "specs") return <Specs payload={page.payload} />;
  if (page.selection.view === "skills") return <Skills skills={page.payload.skillInventory} />;
  return <Dashboard payload={page.payload} />;
}

function Sidebar({ page }: { page: StudioPage }) {
  return (
    <aside className="rail studio-sidebar" id="studio-rail">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark">M</span>
        <div className="sidebar-brand-copy">
          <strong>{STUDIO_TITLE}</strong>
          <span>Developer lookup</span>
        </div>
      </div>
      <CompanionSelector inventory={page.inventory} selection={page.selection} />
      <ViewNav selection={page.selection} />
      <Metrics page={page} />
      <Footer page={page} />
    </aside>
  );
}

function PageHeader({ page }: { page: StudioPage }) {
  if (!page.companion) return null;

  const details = VIEW_DETAILS[page.selection.view];

  return (
    <header className="page-header">
      <div className="page-heading">
        <p className="page-eyebrow">{details.eyebrow}</p>
        <h1>{details.title}</h1>
      </div>
      <div className="page-context">
        <span className="page-context-label">Companion Repository</span>
        <code>{page.companion.path}</code>
        <span className="snapshot-status">
          <span className="snapshot-dot" aria-hidden="true" />
          {page.collectedAt === null
            ? "No snapshot"
            : `Snapshot ${formatCollectedAt(page.collectedAt)}`}
        </span>
      </div>
    </header>
  );
}

/**
 * Submit buttons, so switching a view is a navigation to the URL naming it and
 * the browser's history moves between rendered states.
 */
function ViewNav({ selection }: { selection: StudioSelection }) {
  return (
    <nav className="sidebar-nav" aria-label="Studio views">
      <span className="sidebar-label">Views</span>
      <form method="get" action="/">
        <SelectionFields selection={selection} omit="view" dropOpenPath />
        <div className="sidebar-nav-list">
          <button
            type="submit"
            name="view"
            value="dashboard"
            aria-pressed={selection.view === "dashboard"}
          >
            <span>Overview</span>
          </button>
          <button type="submit" name="view" value="vault" aria-pressed={selection.view === "vault"}>
            <span>Vault</span>
          </button>
          <button type="submit" name="view" value="specs" aria-pressed={selection.view === "specs"}>
            <span>Specs</span>
          </button>
          <button
            type="submit"
            name="view"
            value="workflow"
            aria-pressed={selection.view === "workflow"}
          >
            <span>Workflow</span>
          </button>
          <button
            type="submit"
            name="view"
            value="skills"
            aria-pressed={selection.view === "skills"}
          >
            <span>Skills</span>
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
  dropOpenPath = false,
}: {
  selection: StudioSelection;
  omit?: keyof StudioSelection;
  dropOpenPath?: boolean;
}) {
  return (
    <>
      {selection.companionDigest && omit !== "companionDigest" ? (
        <input type="hidden" name="companion" value={selection.companionDigest} />
      ) : null}
      {selection.view !== "dashboard" && omit !== "view" ? (
        <input type="hidden" name="view" value={selection.view} />
      ) : null}
      {selection.view === "vault" && selection.openPath && !dropOpenPath ? (
        <input type="hidden" name={FILE_PARAM} value={selection.openPath} />
      ) : null}
    </>
  );
}

function Vault({ page }: { page: StudioPage }) {
  const vault = page.vault;
  if (!vault)
    return (
      <section className="panel">
        <p className="empty">No vault state collected.</p>
      </section>
    );
  return (
    <section className="vault-layout">
      <div className="panel vault-tree-panel">
        <div className="section-header">
          <div>
            <h3>Markdown files</h3>
            <p className="section-note">
              {vault.tree.length === 0
                ? "This companion has no markdown files."
                : "Every non-ignored markdown file in this companion."}
            </p>
          </div>
          {!vault.watching ? (
            <form method="get" action="/" data-studio-navigation>
              <SelectionFields selection={page.selection} />
              <input type="hidden" name={REFRESH_PARAM} value="1" />
              <button type="submit">Refresh tree</button>
            </form>
          ) : null}
        </div>
        {vault.warning ? (
          <p className="note vault-warning">{vault.warning}. The tree may be out of date.</p>
        ) : null}
        <nav aria-label="Markdown files">
          {vault.tree.map((node) => (
            <VaultNode key={node.path} node={node} selection={page.selection} />
          ))}
        </nav>
      </div>
      <VaultEditor page={page} vault={vault} />
    </section>
  );
}

function VaultNode({ node, selection }: { node: VaultTreeNode; selection: StudioSelection }) {
  if (node.kind === "directory") {
    return (
      <details open className="vault-directory">
        <summary>{node.name}</summary>
        <div className="vault-children">
          {node.children?.map((child) => (
            <VaultNode key={child.path} node={child} selection={selection} />
          ))}
        </div>
      </details>
    );
  }
  return (
    <form method="get" action="/" className="vault-file" data-studio-navigation>
      <SelectionFields selection={selection} dropOpenPath />
      <input type="hidden" name={FILE_PARAM} value={node.path} />
      <button type="submit" aria-current={selection.openPath === node.path ? "page" : undefined}>
        {node.name}
      </button>
    </form>
  );
}

function VaultEditor({ page, vault }: { page: StudioPage; vault: StudioVaultPage }) {
  if (!vault.open) {
    return (
      <div className="panel vault-editor-panel">
        <h3>{vault.refusal ? "File refused" : "Open a markdown file"}</h3>
        <p className={vault.refusal ? "note vault-warning" : "empty"}>
          {vault.refusal ?? "Choose a file from the tree to begin."}
        </p>
      </div>
    );
  }
  return (
    <div
      className="panel vault-editor-panel"
      data-vault-root
      data-vault-writable={page.writable ? "true" : "false"}
    >
      <div className="section-header">
        <div>
          <h3>{vault.open.path}</h3>
          <p className="section-note">
            {page.writable
              ? "Changes stay in the editor until you save."
              : "Read-only mode. Start Studio with --writable to save."}
          </p>
        </div>
        {page.writable ? (
          <button type="button" id="vault-save">
            Save
          </button>
        ) : null}
      </div>
      <textarea
        id="vault-editor"
        data-vault-editor
        data-vault-path={vault.open.path}
        data-vault-token={vault.open.token}
        spellCheck={false}
      >
        {vault.open.content}
      </textarea>
      <p id="vault-status" className="note" aria-live="polite" />
      <div id="vault-incoming" className="vault-incoming" hidden>
        <strong id="vault-incoming-title">Incoming version</strong>
        <pre id="vault-incoming-content" />
        <button type="button" id="vault-recover">
          Put incoming content back
        </button>
      </div>
    </div>
  );
}
