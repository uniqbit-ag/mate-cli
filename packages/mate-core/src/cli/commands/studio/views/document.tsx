/** @jsxImportSource hono/jsx */

import {
  companionDigest,
  openFile,
  openFolder,
  refresh,
  type StudioSelection,
  type StudioVaultSelection,
  type StudioView,
  switchView,
  toHref,
} from "../selection";
import { REPORTS_ROUTE, VAULT_CHANGES_ROUTE, VAULT_DIR_ROUTE, VAULT_FILTER_ROUTE } from "../routes";
import { STUDIO_CLIENT_SCRIPT, STUDIO_PREPAINT_SCRIPT } from "./client";
import { CompanionPicker } from "./companion-picker";
import { CompanionSelector } from "./companion-selector";
import { Dashboard } from "./dashboard/index";
import { CompanionError } from "./error";
import { formatCollectedAt, type StudioPage, type StudioVaultPage } from "./model";
import type { VaultTreeNode } from "../vault";
import { Reports } from "./reports/index";
import { Specs } from "./specs/index";
import { SelectionFields } from "./selection-fields";
import { STUDIO_STYLES } from "./styles";
import { Skills } from "./skills/index";
import { Workflow } from "./workflow/index";
import {
  STUDIO_TERMINAL_PREPAINT_SCRIPT,
  STUDIO_TERMINAL_SCRIPT,
  STUDIO_TERMINAL_SIDEBAR_SCRIPT,
  TerminalDrawerButton,
  TerminalSidebar,
} from "./terminal";
import { TERMINAL_SCRIPTS, TERMINAL_STYLESHEET } from "../terminal-assets";

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
  reports: {
    eyebrow: "Agent output",
    title: "Reports",
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
  /** The terminal client is Studio's only library, served by Studio itself and only with the terminal. */
  const terminalHead = page.terminal
    ? `\n<link rel="stylesheet" href="${TERMINAL_STYLESHEET}">\n<script>${STUDIO_TERMINAL_PREPAINT_SCRIPT}</script>`
    : "";
  const terminalBody = page.terminal
    ? `${TERMINAL_SCRIPTS.map((src) => `\n<script src="${src}"></script>`).join("")}\n<script>${STUDIO_TERMINAL_SIDEBAR_SCRIPT}</script>\n<script>${STUDIO_TERMINAL_SCRIPT}</script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${STUDIO_TITLE}</title>
<style>${STUDIO_STYLES}</style>
<script>${STUDIO_PREPAINT_SCRIPT}</script>${terminalHead}
</head>
<body>${String(<StudioShell page={page} />)}
<script>${STUDIO_CLIENT_SCRIPT}</script>${terminalBody}
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
        data-terminal={page.terminal ? "" : undefined}
        {...reportAttributes(page)}
      >
        <Sidebar page={page} />
        <main className="main">
          {page.companion ? <PageHeader page={page} /> : null}
          <Content page={page} />
        </main>
        {page.terminal ? <TerminalSidebar terminal={page.terminal} /> : null}
      </div>
      {page.terminal ? <TerminalDrawerButton /> : null}
      <div className="toast" id="studio-toast" data-shown="false" />
      <div className="toast toast-report" id="reports-toast" data-shown="false" role="status">
        <span id="reports-toast-title" />
        <a id="reports-toast-open">Open</a>
      </div>
    </>
  );
}

/** What the page client needs to follow the shown companion's reports; nothing without one. */
function reportAttributes(page: StudioPage): Record<string, string> {
  if (!page.companion) return {};
  const digest = companionDigest(page.companion.path);
  const query = new URLSearchParams({ companion: digest });
  const events = new URLSearchParams({ companion: digest, scope: "reports" });
  return {
    "data-reports-url": `${REPORTS_ROUTE}?${query}`,
    "data-reports-events-url": `${VAULT_CHANGES_ROUTE}?${events}`,
    "data-reports-view-url": toHref(switchView(page.selection, "reports"), "/"),
  };
}

function Content({ page }: { page: StudioPage }) {
  if (!page.companion) {
    return <CompanionPicker inventory={page.inventory} selection={page.selection} />;
  }
  if (page.error) {
    return <CompanionError companionPath={page.error.companionPath} reason={page.error.reason} />;
  }
  if (page.selection.view === "vault") return <Vault page={page} selection={page.selection} />;
  if (page.selection.view === "reports") return <Reports />;
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

const VIEW_NAV: readonly (readonly [StudioView, string])[] = [
  ["dashboard", "Overview"],
  ["vault", "Vault"],
  ["specs", "Specs"],
  ["workflow", "Workflow"],
  ["skills", "Skills"],
  ["reports", "Reports"],
];

/**
 * One GET form per view, so switching a view is a navigation to the URL naming
 * it and the browser's history moves between rendered states.
 */
function ViewNav({ selection }: { selection: StudioSelection }) {
  return (
    <nav className="sidebar-nav" aria-label="Studio views">
      <span className="sidebar-label">Views</span>
      <div className="sidebar-nav-list">
        {VIEW_NAV.map(([view, label]) => (
          <form key={view} method="get" action="/" data-studio-view={view}>
            <SelectionFields selection={switchView(selection, view)} />
            <button type="submit" aria-pressed={selection.view === view}>
              <span>{label}</span>
              {view === "reports" ? (
                <span id="reports-badge" className="nav-badge" hidden>
                  new
                </span>
              ) : null}
            </button>
          </form>
        ))}
      </div>
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

/** The refresh control is the only thing that collects again, so only it leads to a refresh. */
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
          <SelectionFields selection={refresh(page.selection)} />
          <button type="submit">Refresh</button>
        </form>
      </div>
      <button id="studio-theme" type="button" data-theme-state="system">
        Theme: system
      </button>
    </div>
  );
}

/** The tree and folder listing, fetched by the page when it was served before the listing finished. */
export function renderVaultView(page: StudioPage): string {
  const { selection, vault } = page;
  if (!vault || selection.view !== "vault") return "";
  return String(
    <>
      <VaultTreeSlot vault={vault} selection={selection} />
      {vault.open || vault.refusal || selection.openPath ? null : (
        <VaultListingSlot selection={selection} vault={vault} />
      )}
    </>,
  );
}

/** A folder's entries, for a folder the page did not expand; `null` when the listed tree lacks it. */
export function renderVaultChildren(page: StudioPage): string | null {
  const { selection, vault } = page;
  if (!vault?.tree || selection.view !== "vault" || !selection.openDir) return null;
  const folder = findDirectory(vault.tree, selection.openDir);
  if (!folder) return null;
  const nobody = new Set<string>();
  return String(
    <>
      {(folder.children ?? []).toSorted(byKindThenName).map((child) => (
        <VaultNode key={child.path} node={child} selection={selection} expanded={nobody} />
      ))}
    </>,
  );
}

/** Most matches a filter shows; the rest are counted, not rendered. */
export const VAULT_FILTER_LIMIT = 200;

function matchingFiles(
  tree: VaultTreeNode[],
  needle: string,
): { shown: VaultTreeNode[]; total: number } {
  const shown: VaultTreeNode[] = [];
  let total = 0;
  const stack = [...tree].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.kind === "directory") {
      for (let index = (node.children?.length ?? 0) - 1; index >= 0; index -= 1) {
        stack.push(node.children![index]!);
      }
    } else if (segments(node.path).join("/").toLowerCase().includes(needle)) {
      total += 1;
      if (shown.length < VAULT_FILTER_LIMIT) shown.push(node);
    }
  }
  return { shown, total };
}

/** Name-filter results over the whole listed tree, bounded; never touches the disk. */
export function renderVaultMatches(page: StudioPage, query: string): string {
  const { selection, vault } = page;
  const needle = query.trim().toLowerCase();
  if (!vault?.tree || selection.view !== "vault" || !needle) return "";
  const { shown, total } = matchingFiles(vault.tree, needle);
  return String(
    <>
      {shown.length === 0 ? (
        <p className="empty">No files match.</p>
      ) : (
        <nav className="vault-tree vault-results" aria-label="Matching files">
          {shown.map((node) => (
            <VaultFileLink
              key={node.path}
              node={node}
              selection={selection}
              label={segments(node.path).join("/")}
            />
          ))}
        </nav>
      )}
      {total > shown.length ? (
        <p className="note" data-vault-more>
          {total - shown.length} more match{total - shown.length === 1 ? "" : "es"}; refine the
          filter.
        </p>
      ) : null}
    </>,
  );
}

/** The selection a read-only vault route is addressed by: no one-shot refresh. */
function plain(selection: StudioVaultSelection): StudioVaultSelection {
  return { ...selection, refresh: false };
}

function segments(relative: string): string[] {
  return relative.split(/[\\/]/).filter(Boolean);
}

/** Walks node names, so a requested folder is only ever one the listed tree holds. */
function findDirectory(tree: VaultTreeNode[], relative: string): VaultTreeNode | null {
  let level = tree;
  let found: VaultTreeNode | null = null;
  for (const name of segments(relative)) {
    found = level.find((node) => node.kind === "directory" && node.name === name) ?? null;
    if (!found) return null;
    level = found.children ?? [];
  }
  return found;
}

function expandedPaths(selection: StudioVaultSelection): Set<string> {
  const expanded = new Set<string>();
  const add = (relative: string, includeLast: boolean) => {
    const parts = segments(relative);
    const count = includeLast ? parts.length : parts.length - 1;
    for (let index = 1; index <= count; index += 1) expanded.add(parts.slice(0, index).join("/"));
  };
  if (selection.openPath) add(selection.openPath, false);
  if (selection.openDir) add(selection.openDir, true);
  return expanded;
}

function byKindThenName(a: VaultTreeNode, b: VaultTreeNode): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Drawn in CSS: one empty element per entry keeps a large tree's markup small. */
function FolderIcon() {
  return <span className="vault-icon vault-icon-folder" aria-hidden="true" />;
}

function FileIcon() {
  return <span className="vault-icon vault-icon-file" aria-hidden="true" />;
}

function Chevron() {
  return <span className="vault-chevron" aria-hidden="true" />;
}

function Vault({ page, selection }: { page: StudioPage; selection: StudioVaultSelection }) {
  const vault = page.vault;
  if (!vault)
    return (
      <section className="panel">
        <p className="empty">No vault state collected.</p>
      </section>
    );
  const showListing = !vault.open && !vault.refusal;
  return (
    <section
      className="vault-layout"
      data-vault-layout
      data-vault-view={vault.tree === null ? toHref(selection, "/api/vault/view") : undefined}
      data-vault-refresh-url={toHref(refresh(selection), "/api/vault/view")}
      data-vault-filter-url={toHref(plain(selection), VAULT_FILTER_ROUTE)}
      data-vault-changes-url={toHref(plain(selection), VAULT_CHANGES_ROUTE)}
    >
      <aside className="panel vault-tree-panel" id="vault-tree-panel" aria-label="Files">
        <div className="vault-tree-head">
          <strong>Files</strong>
          <RefreshTree selection={selection} />
        </div>
        <p id="vault-stale" className="note vault-warning" role="status" hidden>
          Files changed — refresh tree.
        </p>
        <p id="vault-refresh-status" className="note vault-warning" role="status" hidden />
        <input
          type="search"
          id="vault-filter"
          className="vault-filter"
          placeholder="Go to file"
          aria-label="Go to file"
          hidden
        />
        <div id="vault-filter-results" data-vault-filter-results hidden />
        <VaultTreeSlot vault={vault} selection={selection} />
      </aside>
      <div className="vault-main">
        <div className="vault-bar">
          <button
            type="button"
            id="vault-tree-toggle"
            className="vault-tree-toggle"
            aria-controls="vault-tree-panel"
            aria-expanded="true"
            hidden
          >
            Hide files
          </button>
          <VaultBreadcrumb page={page} selection={selection} />
        </div>
        {showListing ? <VaultListingSlot selection={selection} vault={vault} /> : null}
        {showListing ? null : <VaultEditor page={page} selection={selection} vault={vault} />}
      </div>
    </section>
  );
}

/** The refresh that keeps the tree and filter data current; without script it is a plain reload. */
function RefreshTree({ selection }: { selection: StudioVaultSelection }) {
  return (
    <form method="get" action="/" data-studio-navigation data-vault-refresh>
      <SelectionFields selection={refresh(selection)} />
      <button type="submit">Refresh tree</button>
    </form>
  );
}

function VaultTreeSlot({
  vault,
  selection,
}: {
  vault: StudioVaultPage;
  selection: StudioVaultSelection;
}) {
  if (vault.failure) {
    return (
      <div data-vault-slot="tree">
        <p className="note vault-warning">The files could not be listed: {vault.failure}</p>
      </div>
    );
  }
  if (vault.tree === null) {
    return (
      <div data-vault-slot="tree" aria-busy="true">
        <p className="empty">Listing files…</p>
      </div>
    );
  }
  const expanded = expandedPaths(selection);
  return (
    <div data-vault-slot="tree" data-vault-generation={vault.generation ?? undefined}>
      {vault.warning ? (
        <p className="note vault-warning">{vault.warning}. The tree may be out of date.</p>
      ) : vault.watching ? null : (
        <p className="note vault-warning">The tree may be out of date.</p>
      )}
      {vault.tree.length === 0 ? (
        <p className="empty">This companion has no markdown files.</p>
      ) : (
        <nav className="vault-tree" aria-label="Markdown files">
          {vault.tree.toSorted(byKindThenName).map((node) => (
            <VaultNode key={node.path} node={node} selection={selection} expanded={expanded} />
          ))}
        </nav>
      )}
    </div>
  );
}

function VaultNode({
  node,
  selection,
  expanded,
}: {
  node: VaultTreeNode;
  selection: StudioVaultSelection;
  expanded: Set<string>;
}) {
  const key = segments(node.path).join("/");
  if (node.kind === "directory") {
    const open = expanded.has(key);
    return (
      <details
        className="vault-directory"
        open={open}
        data-vault-dir={key}
        data-vault-expanded={open ? "" : undefined}
        data-vault-children-url={
          open ? undefined : toHref(openFolder(selection, key), VAULT_DIR_ROUTE)
        }
      >
        <summary
          aria-current={
            selection.openDir && segments(selection.openDir).join("/") === key ? "page" : undefined
          }
        >
          <Chevron />
          <FolderIcon />
          <span>{node.name}</span>
        </summary>
        <div className="vault-children">
          {open
            ? (node.children ?? [])
                .toSorted(byKindThenName)
                .map((child) => (
                  <VaultNode
                    key={child.path}
                    node={child}
                    selection={selection}
                    expanded={expanded}
                  />
                ))
            : null}
        </div>
      </details>
    );
  }
  return <VaultFileLink node={node} selection={selection} label={node.name} />;
}

/** A plain link: no form, no hidden fields, no handler of its own. */
function VaultFileLink({
  node,
  selection,
  label,
}: {
  node: VaultTreeNode;
  selection: StudioVaultSelection;
  label: string;
}) {
  return (
    <a
      className="vault-file"
      href={toHref(openFile(selection, node.path))}
      data-vault-entry={segments(node.path).join("/")}
      aria-current={selection.openPath === node.path ? "page" : undefined}
    >
      <FileIcon />
      <span>{label}</span>
    </a>
  );
}

function OpenFolder({
  selection,
  relative,
  className,
  children,
}: {
  selection: StudioVaultSelection;
  relative: string | null;
  className?: string;
  children: unknown;
}) {
  return (
    <form method="get" action="/" className={className} data-studio-navigation>
      <SelectionFields selection={openFolder(selection, relative)} />
      <button type="submit">{children}</button>
    </form>
  );
}

/** Built from the selection alone, so it renders before the tree is listed. */
function VaultBreadcrumb({
  page,
  selection,
}: {
  page: StudioPage;
  selection: StudioVaultSelection;
}) {
  const current = selection.openPath ?? selection.openDir ?? "";
  const parts = segments(current);
  const rootName = page.companion
    ? (segments(page.companion.path).at(-1) ?? "companion")
    : "companion";
  return (
    <nav className="vault-breadcrumb" aria-label="Breadcrumb">
      <ol>
        <li>
          {parts.length === 0 ? (
            <span aria-current="page">{rootName}</span>
          ) : (
            <OpenFolder selection={selection} relative={null} className="vault-crumb">
              {rootName}
            </OpenFolder>
          )}
        </li>
        {parts.map((name, index) => (
          <li key={parts.slice(0, index + 1).join("/")}>
            {index === parts.length - 1 ? (
              <span aria-current="page">{name}</span>
            ) : (
              <OpenFolder
                selection={selection}
                relative={parts.slice(0, index + 1).join("/")}
                className="vault-crumb"
              >
                {name}
              </OpenFolder>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function VaultListingSlot({
  selection,
  vault,
}: {
  selection: StudioVaultSelection;
  vault: StudioVaultPage;
}) {
  if (vault.failure) {
    return (
      <div data-vault-slot="listing" className="panel vault-listing">
        <p className="note vault-warning">The files could not be listed: {vault.failure}</p>
      </div>
    );
  }
  if (vault.tree === null) {
    return (
      <div data-vault-slot="listing" className="panel vault-listing" aria-busy="true">
        <p className="empty">Listing files…</p>
      </div>
    );
  }
  const requested = selection.openDir ? findDirectory(vault.tree, selection.openDir) : null;
  const entries = (requested ? (requested.children ?? []) : vault.tree).toSorted(byKindThenName);
  const parts = requested ? segments(selection.openDir ?? "") : [];
  return (
    <div data-vault-slot="listing" className="panel vault-listing">
      {selection.openDir !== null && requested === null ? (
        <p className="note vault-warning">That folder is not in the tree; showing the root.</p>
      ) : null}
      {entries.length === 0 && parts.length === 0 ? (
        <p className="empty">This companion has no markdown files.</p>
      ) : (
        <VaultListingRows selection={selection} parts={parts} entries={entries} />
      )}
    </div>
  );
}

function VaultListingRows({
  selection,
  parts,
  entries,
}: {
  selection: StudioVaultSelection;
  parts: string[];
  entries: VaultTreeNode[];
}) {
  return (
    <ul className="vault-rows" aria-label="Folder contents">
      {parts.length > 0 ? (
        <li>
          <OpenFolder
            selection={selection}
            relative={parts.length > 1 ? parts.slice(0, -1).join("/") : null}
            className="vault-row"
          >
            <FolderIcon />
            <span>..</span>
          </OpenFolder>
        </li>
      ) : null}
      {entries.map((node) => (
        <li key={node.path}>
          <VaultListingEntry selection={selection} node={node} />
        </li>
      ))}
    </ul>
  );
}

function VaultListingEntry({
  selection,
  node,
}: {
  selection: StudioVaultSelection;
  node: VaultTreeNode;
}) {
  if (node.kind === "directory") {
    return (
      <OpenFolder
        selection={selection}
        relative={segments(node.path).join("/")}
        className="vault-row"
      >
        <FolderIcon />
        <span>{node.name}</span>
      </OpenFolder>
    );
  }
  return (
    <form method="get" action="/" className="vault-row" data-studio-navigation>
      <SelectionFields selection={openFile(selection, node.path)} />
      <button type="submit">
        <FileIcon />
        <span>{node.name}</span>
      </button>
    </form>
  );
}

function VaultEditor({
  page,
  selection,
  vault,
}: {
  page: StudioPage;
  selection: StudioVaultSelection;
  vault: StudioVaultPage;
}) {
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
          <h3>{segments(vault.open.path).at(-1) ?? vault.open.path}</h3>
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
        data-vault-events={toHref(openFile(selection, vault.open.path), "/api/vault/events")}
        data-vault-token={vault.open.token}
        {...(page.writable ? {} : { readOnly: true })}
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
