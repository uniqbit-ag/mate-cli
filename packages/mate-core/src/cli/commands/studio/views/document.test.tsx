import { describe, expect, it } from "bun:test";

import {
  companionDigest,
  openFile,
  openFolder,
  parse,
  parseVaultSelection,
  STUDIO_VIEWS,
  type StudioSelection,
  switchView,
  toFields,
} from "../selection";
import {
  renderStudioDocument,
  renderVaultChildren,
  renderVaultMatches,
  renderVaultView,
  VAULT_FILTER_LIMIT,
} from "./document";
import { fixtureTree } from "../../../../../test/studio-vault-fixture";
import { formatCollectedAt, type StudioPage, type StudioVaultPage } from "./model";
import type { VaultTreeNode } from "../vault";

/** Every GET form's attributes, button text, and hidden fields, decoded as the browser submits them. */
function forms(markup: string) {
  const decode = (value: string) =>
    value
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
  return [...markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map(([, attrs, body]) => ({
    attrs: attrs!,
    body: body!,
    fields: [...body!.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)"\/>/g)].map(
      ([, name, value]) => ({ name: decode(name!), value: decode(value!) }),
    ),
  }));
}

function submitted(fields: { name: string; value: string }[]): StudioSelection {
  const url = new URL("http://localhost:1/");
  for (const { name, value } of fields) url.searchParams.append(name, value);
  return parse(url);
}

function viewForm(markup: string, view: string): string {
  const form = forms(markup).find(({ attrs }) => attrs.includes(`data-studio-view="${view}"`));
  return form ? form.body : "";
}

const acme = "/home/dev/.mate/companions/acme-companion";
const digest = companionDigest(acme);

function page(overrides: Partial<StudioPage> = {}): StudioPage {
  return {
    inventory: { companions: [{ path: acme, health: "ready", pairings: [] }] },
    selection: { companionDigest: null, view: "dashboard", refresh: false },
    companion: null,
    payload: null,
    error: null,
    collectedAt: null,
    ...overrides,
  };
}

const selected: StudioPage = page({
  selection: { companionDigest: digest, view: "dashboard", refresh: false },
  collectedAt: Date.UTC(2026, 0, 2, 12, 34, 56),
  companion: { path: acme, health: "ready", pairings: [] },
  payload: {
    companionPath: acme,
    changes: [{ name: "add-auth", completedTasks: 1, totalTasks: 4, artifacts: [] }],
    specs: [{ capability: "acme-login", areas: ["acme"] }],
    skills: ["mate-interview-me", "mate-grill-me", "mate-grill-with-docs"],
    skillInventory: {
      claude: ["mate-interview-me", "mate-grill-me", "mate-grill-with-docs"],
      opencode: ["mate-interview-me", "mate-grill-me"],
      agents: ["mate-domain-modeling"],
    },
    topology: null,
    warnings: [],
  },
});

describe("renderStudioDocument", () => {
  it("serves one self-contained document", () => {
    const markup = renderStudioDocument(page());
    expect(markup.startsWith("<!doctype html>")).toBe(true);
    expect(markup).toContain('<html lang="en">');
    expect(markup).toContain("<title>Mate Studio</title>");
    expect(markup).toContain("</html>");
  });

  it("carries its styles and its behavior inline", () => {
    const markup = renderStudioDocument(page());
    expect(markup).toContain("<style>");
    expect(markup).toContain("--accent:");
    expect(markup).toContain("<script>");
    expect(markup).not.toContain("<link");
    expect(markup).not.toContain("src=");
  });

  it("references no external host", () => {
    const markup = renderStudioDocument(selected);
    for (const url of markup.match(/https?:\/\/[^"'\s)]+/g) ?? []) {
      expect(url).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1)/);
    }
  });

  it("applies the remembered appearance before the body", () => {
    const markup = renderStudioDocument(page());
    expect(markup.indexOf("mate-studio-theme")).toBeLessThan(markup.indexOf("<body>"));
    expect(markup).toContain('data-theme", chosen');
  });

  it("keeps the CSS and the JavaScript unescaped inside their raw-text elements", () => {
    const markup = renderStudioDocument(page());
    const style = markup.slice(markup.indexOf("<style>"), markup.indexOf("</style>"));
    expect(style).toContain(':root:not([data-theme="dark"])');
    expect(style).not.toContain("&quot;");
    expect(markup).toContain('THEME_CYCLE = ["system", "dark", "light"]');
    expect(markup).not.toContain("&amp;&amp;");
  });

  it("renders the selector and view switch around every state", () => {
    for (const state of [page(), selected]) {
      const markup = renderStudioDocument(state);
      expect(markup).toContain('aria-label="Companion Repository"');
      expect(markup).not.toContain("Working repositories");
      expect(markup).toContain('name="view" value="workflow"');
      expect(markup).toContain('name="view" value="skills"');
      expect(markup).not.toContain('id="studio-change"');
      expect(markup).toContain('id="studio-theme"');
      expect(markup).toContain('id="studio-toast"');
    }
  });

  it("offers every companion as a card when none is named", () => {
    const markup = renderStudioDocument(page());
    expect(markup).toContain("<h3>Choose a Companion Repository</h3>");
    expect(markup).toContain(`value="${digest}" class="picker-card"`);
    expect(markup).toContain("acme-companion");
    expect(markup).not.toContain("<h3>Changes</h3>");
  });

  it("names the resolved companion for the browser to remember, and nothing else", () => {
    expect(renderStudioDocument(selected)).toContain(
      `<div class="shell" data-companion="${digest}"`,
    );
    expect(renderStudioDocument(page())).toContain('<div class="shell">');
    expect(
      renderStudioDocument(
        page({ selection: { companionDigest: "deadbeef00", view: "dashboard", refresh: false } }),
      ),
    ).toContain('<div class="shell">');
  });

  it("presents the named companion's Dashboard", () => {
    const markup = renderStudioDocument(selected);
    expect(markup).toContain("<h3>Changes</h3>");
    expect(markup).not.toContain("<h3>Specs by Area</h3>");
    expect(markup).toContain("add-auth");
    expect(markup).toContain('aria-pressed="true"');
  });

  it("surfaces the current view and snapshot context", () => {
    const markup = renderStudioDocument(selected);
    expect(markup).toContain("<h1>Overview</h1>");
    expect(markup).toContain('<span class="page-context-label">Companion Repository</span>');
    expect(markup).toContain(`<code>${acme}</code>`);
    expect(markup).toContain("Snapshot 12:34:56");
  });

  it("presents the Specs view when the URL names it", () => {
    const markup = renderStudioDocument({
      ...selected,
      selection: { ...selected.selection, view: "specs" },
    });
    expect(markup).toContain("<h3>Specs by Area</h3>");
    expect(markup).not.toContain("<h3>Changes</h3>");
    expect(viewForm(markup, "specs")).toContain('aria-pressed="true"');
  });

  it("presents the Workflow view when the URL names it", () => {
    const markup = renderStudioDocument({
      ...selected,
      selection: { ...selected.selection, view: "workflow" },
    });
    expect(markup).toContain('class="workflow-console"');
    expect(markup).not.toContain("mate workflow --read-only");
    expect(markup).not.toContain('id="studio-change"');
    expect(markup).not.toContain("<h3>Changes</h3>");
  });

  it("presents the Skills view with runtime tabs", () => {
    const markup = renderStudioDocument({
      ...selected,
      selection: { ...selected.selection, view: "skills" },
    });
    expect(markup).toContain("<h3>Agent Skills</h3>");
    expect(markup).toContain('role="tablist" aria-label="Skill source"');
    expect(markup).toContain('id="skills-tab-claude"');
    expect(markup).toContain('id="skills-tab-opencode"');
    expect(markup).toContain('id="skills-tab-agents"');
    expect(markup).toContain("mate-grill-with-docs");
    expect(markup).toContain("mate-interview-me");
    expect(markup).toContain("mate-domain-modeling");
    expect(viewForm(markup, "skills")).toContain('aria-pressed="true"');
  });

  it("presents the Vault view and an opened file", () => {
    const markup = renderStudioDocument({
      ...selected,
      selection: { ...selected.selection, view: "vault", openPath: "docs/note.md" },
      payload: null,
      vault: {
        tree: [
          {
            name: "docs",
            path: "docs",
            kind: "directory",
            children: [{ name: "note.md", path: "docs/note.md", kind: "file" }],
          },
        ],
        open: { path: "docs/note.md", content: "# note", token: "token" },
        refusal: null,
        incoming: null,
        overwritten: null,
        watching: true,
        warning: null,
      },
      writable: true,
    });
    expect(markup).toContain("<h1>Vault</h1>");
    expect(viewForm(markup, "vault")).toContain('aria-pressed="true"');
    expect(viewForm(markup, "dashboard")).toContain('aria-pressed="false"');
    expect(markup).toContain('id="vault-editor"');
    expect(markup).toContain(
      `data-vault-events="/api/vault/events?companion=${digest}&amp;view=vault&amp;path=docs%2Fnote.md"`,
    );
    expect(markup).toContain("# note");
    expect(markup).toContain("Save");
    expect(markup).not.toMatch(/<textarea[^>]*readonly/i);
  });

  describe("vault folder view", () => {
    const tree: VaultTreeNode[] = [
      { name: "README.md", path: "README.md", kind: "file" },
      {
        name: "docs",
        path: "docs",
        kind: "directory",
        children: [
          { name: "b.md", path: "docs/b.md", kind: "file" },
          {
            name: "a",
            path: "docs/a",
            kind: "directory",
            children: [{ name: "x.md", path: "docs/a/x.md", kind: "file" }],
          },
        ],
      },
      {
        name: "other",
        path: "other",
        kind: "directory",
        children: [{ name: "y.md", path: "other/y.md", kind: "file" }],
      },
    ];
    const state = (overrides: Partial<StudioVaultPage> = {}): StudioVaultPage => ({
      tree,
      open: null,
      refusal: null,
      incoming: null,
      overwritten: null,
      watching: true,
      warning: null,
      ...overrides,
    });
    const vaultPage = (
      selection: Partial<StudioPage["selection"]>,
      vault: StudioVaultPage = state(),
    ): StudioPage => ({
      ...selected,
      selection: {
        ...selected.selection,
        view: "vault",
        openPath: null,
        openDir: null,
        ...selection,
      },
      payload: null,
      vault,
    });
    const opened = (markup: string, dir: string) =>
      new RegExp(`<details[^>]*open=""[^>]*data-vault-dir="${dir}"`).test(markup);
    const closed = (markup: string, dir: string) =>
      new RegExp(`<details class="vault-directory" data-vault-dir="${dir}"`).test(markup);

    it("expands only the folders on the way to the open file", () => {
      const markup = renderStudioDocument(
        vaultPage(
          { openPath: "docs/a/x.md" },
          state({ open: { path: "docs/a/x.md", content: "x", token: "t" } }),
        ),
      );
      expect(opened(markup, "docs")).toBe(true);
      expect(opened(markup, "docs/a")).toBe(true);
      expect(closed(markup, "other")).toBe(true);
      expect(markup).toContain('class="vault-icon vault-icon-folder"');
      expect(markup).toContain('class="vault-icon vault-icon-file"');
      expect(markup).not.toContain('data-vault-slot="listing"');
    });

    it("lists an open folder's entries, folders first, with its parent", () => {
      const markup = renderVaultView(vaultPage({ openDir: "docs" }));
      const listing = markup.slice(markup.indexOf('data-vault-slot="listing"'));
      expect(listing.indexOf("<span>..</span>")).toBeGreaterThan(-1);
      expect(listing.indexOf("<span>a</span>")).toBeLessThan(listing.indexOf("<span>b.md</span>"));
      expect(listing).not.toContain("README.md");
      expect(listing).toContain('name="dir" value="docs/a"');
      expect(listing).toContain('name="path" value="docs/b.md"');
      expect(opened(markup, "docs")).toBe(true);
    });

    it("leads the breadcrumb back through each folder", () => {
      const markup = renderStudioDocument(
        vaultPage(
          { openPath: "docs/a/x.md" },
          state({ open: { path: "docs/a/x.md", content: "x", token: "t" } }),
        ),
      );
      const crumbs = markup.slice(markup.indexOf('aria-label="Breadcrumb"'));
      const breadcrumb = crumbs.slice(0, crumbs.indexOf("</nav>"));
      expect(breadcrumb).toContain("acme-companion");
      expect(breadcrumb).toContain('name="dir" value="docs"');
      expect(breadcrumb).toContain('name="dir" value="docs/a"');
      expect(breadcrumb).toContain('<span aria-current="page">x.md</span>');
    });

    it("lists the root for a folder the tree does not hold", () => {
      const markup = renderVaultView(vaultPage({ openDir: "../outside" }));
      expect(markup).toContain("That folder is not in the tree; showing the root.");
      expect(markup).toContain('name="path" value="README.md"');
    });

    it("leads every vault entry to the vault selection it names", () => {
      const selection = { openPath: "docs/a/x.md" } as const;
      const page = vaultPage(
        selection,
        state({ open: { path: "docs/a/x.md", content: "x", token: "t" }, watching: false }),
      );
      const current = page.selection;
      const vaultForms = forms(renderStudioDocument(page)).filter(({ attrs }) =>
        attrs.includes("data-studio-navigation"),
      );
      expect(vaultForms.length).toBeGreaterThan(2);
      const markup = renderStudioDocument(page);
      const links = [...markup.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*data-vault-entry="([^"]*)"/g)];
      expect(links.length).toBeGreaterThan(2);
      for (const [, href, entry] of links) {
        const target = parse(new URL(href!.replaceAll("&amp;", "&"), "http://localhost:1/"));
        expect(target).toEqual(openFile(current, entry!));
      }
      for (const { attrs, body, fields } of vaultForms) {
        const target = submitted(fields);
        if (body.includes("Refresh tree")) expect(target).toEqual({ ...current, refresh: true });
        else {
          expect(target.view).toBe("vault");
          expect(target).toEqual(
            openFolder(current, target.view === "vault" ? target.openDir : null),
          );
        }
      }
      const listing = forms(renderVaultView(vaultPage({ openDir: "docs" }))).map(({ fields }) =>
        submitted(fields),
      );
      expect(listing).toContainEqual(openFile(current, "docs/b.md"));
      expect(listing).toContainEqual(openFolder(current, "docs/a"));
      expect(listing).toContainEqual(openFolder(current, null));
    });

    it("renders collapsed folders empty, addressed by their children route", () => {
      const markup = renderStudioDocument(
        vaultPage(
          { openPath: "docs/a/x.md" },
          state({ open: { path: "docs/a/x.md", content: "x", token: "t" } }),
        ),
      );
      const other = markup.slice(markup.indexOf('data-vault-dir="other"'));
      const details = other.slice(0, other.indexOf("</details>"));
      expect(details).toContain(
        `data-vault-children-url="/api/vault/dir?companion=${digest}&amp;view=vault&amp;dir=other"`,
      );
      expect(details).not.toContain("y.md");
      expect(markup).not.toContain("other/y.md");
      expect(opened(markup, "docs")).toBe(true);
      expect(markup).toContain('data-vault-entry="docs/a/x.md"');
    });

    it("renders a folder's entries as an unexpanded fragment, only for listed folders", () => {
      const fragment = renderVaultChildren(vaultPage({ openDir: "docs" }))!;
      expect(fragment).toContain('data-vault-entry="docs/b.md"');
      expect(fragment).toContain('data-vault-dir="docs/a"');
      expect(fragment).not.toContain("x.md");
      expect(fragment).not.toContain("open=");
      expect(renderVaultChildren(vaultPage({ openDir: "../outside" }))).toBeNull();
      expect(renderVaultChildren(vaultPage({ openDir: null }))).toBeNull();
    });

    it("filters the whole listed tree, including unexpanded folders, and bounds the matches", () => {
      const found = renderVaultMatches(vaultPage({}), "Y.MD");
      expect(found).toContain('data-vault-entry="other/y.md"');
      expect(found).not.toContain("README.md");
      expect(renderVaultMatches(vaultPage({}), "zzz")).toContain("No files match.");
      const large = state({ tree: fixtureTree(VAULT_FILTER_LIMIT * 5) });
      const bounded = renderVaultMatches(vaultPage({}, large), "note-");
      expect(bounded.match(/data-vault-entry=/g)).toHaveLength(VAULT_FILTER_LIMIT);
      expect(bounded).toContain(`${VAULT_FILTER_LIMIT * 4} more matches; refine the filter.`);
    });

    it("keeps the tree markup independent of the repository size and handler-free", () => {
      /** The same hundred top-level folders, each holding `perFolder` files. */
      const count = (perFolder: number) => {
        const wide: VaultTreeNode[] = Array.from({ length: 100 }, (_, folder) => ({
          name: `area-${folder}`,
          path: `area-${folder}`,
          kind: "directory" as const,
          children: Array.from({ length: perFolder }, (_, file) => ({
            name: `note-${file}.md`,
            path: `area-${folder}/note-${file}.md`,
            kind: "file" as const,
          })),
        }));
        const markup = renderVaultView(vaultPage({}, state({ tree: wide })));
        const treeMarkup = markup.slice(0, markup.indexOf('data-vault-slot="listing"'));
        return {
          nodes: (treeMarkup.match(/<[a-z]/g) ?? []).length,
          forms: (treeMarkup.match(/<form\b/g) ?? []).length,
          links: (treeMarkup.match(/<a\b/g) ?? []).length,
        };
      };
      const small = count(1);
      const large = count(200);
      expect(large).toEqual(small);
      expect(large.links).toBe(0);
    });

    it("offers the refresh control and the refresh and filter addresses", () => {
      const markup = renderStudioDocument(vaultPage({ openDir: "docs" }));
      expect(markup).toContain("data-vault-refresh");
      expect(markup).toContain("Refresh tree");
      expect(markup).toContain(
        `data-vault-refresh-url="/api/vault/view?companion=${digest}&amp;view=vault&amp;dir=docs&amp;refresh=1"`,
      );
      expect(markup).toContain(
        `data-vault-filter-url="/api/vault/filter?companion=${digest}&amp;view=vault&amp;dir=docs"`,
      );
      expect(markup).toContain(
        `data-vault-changes-url="/api/vault/changes?companion=${digest}&amp;view=vault&amp;dir=docs"`,
      );
      expect(markup).toContain('id="vault-stale"');
    });

    it("states the tree may be out of date when it is not watched, and carries its generation", () => {
      const markup = renderVaultView(vaultPage({}, state({ watching: false, generation: 7 })));
      expect(markup).toContain("The tree may be out of date.");
      expect(markup).toContain('data-vault-generation="7"');
      expect(renderVaultView(vaultPage({}))).not.toContain("may be out of date");
    });

    it("addresses the deferred tree with the page's own vault selection", () => {
      const page = vaultPage({ openDir: "docs" }, state({ tree: null }));
      const address = /data-vault-view="([^"]*)"/.exec(renderStudioDocument(page))?.[1];
      const url = new URL(address!.replaceAll("&amp;", "&"), "http://localhost:1");
      expect(url.pathname).toBe("/api/vault/view");
      expect(parseVaultSelection(url)).toEqual(page.selection);
    });

    it("serves placeholders and the view address while the tree is listed", () => {
      const markup = renderStudioDocument(vaultPage({ openDir: "docs" }, state({ tree: null })));
      expect(markup).toContain(
        `data-vault-view="/api/vault/view?companion=${digest}&amp;view=vault&amp;dir=docs"`,
      );
      expect(markup.match(/aria-busy="true"/g)).toHaveLength(2);
      expect(markup).toContain('id="vault-filter"');
      expect(markup).toContain('id="vault-tree-toggle"');
    });
  });

  it("renders refused vault paths without an editor", () => {
    const markup = renderStudioDocument({
      ...selected,
      selection: { ...selected.selection, view: "vault", openPath: "../outside.md" },
      payload: null,
      vault: {
        tree: [],
        open: null,
        refusal: "the requested path leaves the companion root",
        incoming: null,
        overwritten: null,
        watching: true,
        warning: null,
      },
    });
    expect(markup).toContain("File refused");
    expect(markup).toContain("the requested path leaves the companion root");
    expect(markup).not.toContain('id="vault-editor"');
  });

  it("omits saving controls in read-only mode", () => {
    const markup = renderStudioDocument({
      ...selected,
      selection: { ...selected.selection, view: "vault", openPath: "note.md" },
      payload: null,
      vault: {
        tree: [{ name: "note.md", path: "note.md", kind: "file" }],
        open: { path: "note.md", content: "one", token: "one" },
        refusal: null,
        incoming: null,
        overwritten: null,
        watching: true,
        warning: null,
      },
      writable: false,
    });
    expect(markup).not.toContain('id="vault-save"');
    expect(markup).toContain("Start Studio with --writable");
    expect(markup).toMatch(/<textarea[^>]*id="vault-editor"[^>]*readonly/i);
  });

  it("renders the two pre-explore choices without offering documentation mode or skip copy", () => {
    const markup = renderStudioDocument({
      ...selected,
      selection: { ...selected.selection, view: "workflow" },
    });
    expect(markup).toContain('data-copy-label="mate-interview-me prompt"');
    expect(markup).toContain('data-copy-label="mate-grill-me prompt"');
    expect(markup).not.toContain('data-copy-label="mate-grill-with-docs command"');
    expect(markup).not.toContain("Skip pre-explore");
  });

  it("presents an unreadable companion as an error while the selector stays usable", () => {
    const markup = renderStudioDocument(
      page({
        selection: { companionDigest: digest, view: "dashboard", refresh: false },
        companion: { path: acme, health: "ready", pairings: [] },
        error: { companionPath: acme, reason: "openspec list --json: exited with 1" },
      }),
    );
    expect(markup).toContain("Could not read this companion");
    expect(markup).toContain("openspec list --json: exited with 1");
    expect(markup).toContain('aria-label="Companion Repository"');
  });

  it("names the snapshot the document was rendered from", () => {
    const markup = renderStudioDocument(selected);
    expect(markup).toContain(`state as of ${formatCollectedAt(selected.collectedAt!)}`);
  });

  it("names no state before a companion is selected", () => {
    const markup = renderStudioDocument(page());
    expect(markup).toContain("no state collected");
    expect(markup).not.toContain("state as of");
  });

  it("asks for a refresh from the refresh control alone", () => {
    const markup = renderStudioDocument({
      ...selected,
      selection: { ...selected.selection, view: "workflow" },
    });
    const refreshFields = markup.match(/name="refresh"/g) ?? [];
    expect(refreshFields).toHaveLength(1);
    expect(markup).toContain('<input type="hidden" name="refresh" value="1"/>');
  });

  it("offers one form per view, each leading to that view alone", () => {
    const current: StudioSelection = {
      companionDigest: digest,
      view: "vault",
      refresh: true,
      openPath: "docs/note.md",
      openDir: null,
    };
    const markup = renderStudioDocument({ ...selected, selection: current, payload: null });
    for (const view of STUDIO_VIEWS) {
      const form = forms(markup).find(({ attrs }) => attrs.includes(`data-studio-view="${view}"`));
      expect(form?.fields).toEqual(toFields(switchView(current, view)));
    }
  });

  it("carries a refresh in no form but a refresh control", () => {
    const current: StudioSelection = {
      companionDigest: digest,
      view: "vault",
      refresh: true,
      openPath: null,
      openDir: "docs",
    };
    const markup = renderStudioDocument({
      ...selected,
      selection: current,
      payload: null,
      vault: {
        tree: [{ name: "docs", path: "docs", kind: "directory", children: [] }],
        open: null,
        refusal: null,
        incoming: null,
        overwritten: null,
        watching: false,
        warning: null,
      },
    });
    const refreshing = forms(markup).filter(({ fields }) =>
      fields.some(({ name }) => name === "refresh"),
    );
    expect(refreshing).toHaveLength(2);
    for (const { body } of refreshing) expect(body).toMatch(/Refresh( tree)?<\/button>/);
  });

  it("carries no refresh forward from the request that asked for one", () => {
    const markup = renderStudioDocument({
      ...selected,
      selection: { ...selected.selection, refresh: true },
    });
    expect(markup.match(/name="refresh"/g) ?? []).toHaveLength(1);
  });

  it("renders a value containing markup characters as text", () => {
    const markup = renderStudioDocument(
      page({
        inventory: {
          companions: [{ path: '"><script>alert(1)</script>', health: "ready", pairings: [] }],
        },
      }),
    );
    expect(markup).not.toContain("<script>alert(1)</script>");
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("terminal view", () => {
  const terminal = {
    pinned: false,
    target: { path: acme, digest },
    agents: ["claude" as const],
  };

  it("references no terminal client without the terminal", () => {
    const markup = renderStudioDocument(selected);
    expect(markup).not.toContain("/studio/terminal/");
    expect(markup).not.toContain("studio-terminal-panel");
    const body = markup.slice(markup.indexOf("<body>"));
    expect(body).not.toContain("data-terminal");
    expect(body).not.toContain("terminal-sidebar");
    expect(body).not.toContain("terminal-drawer-open");
    expect(markup).not.toContain("mate-studio-terminal-width");
  });

  it("docks the sidebar as the shell's child after the main view", () => {
    const markup = renderStudioDocument({ ...selected, terminal });
    expect(markup).toMatch(/<div class="shell"[^>]* data-terminal=""/);
    const mainEnd = markup.indexOf("</main>");
    const sidebar = markup.indexOf('<aside class="terminal-sidebar"');
    const shellEnd = markup.indexOf('<div class="toast"');
    expect(mainEnd).toBeGreaterThan(0);
    expect(sidebar).toBeGreaterThan(mainEnd);
    expect(sidebar).toBeLessThan(shellEnd);
    expect(markup.indexOf('id="terminal-drawer-open"')).toBeGreaterThan(
      markup.indexOf("</aside>", sidebar),
    );
  });

  it("offers collapse, expand, resize, and drawer controls", () => {
    const markup = renderStudioDocument({ ...selected, terminal });
    for (const id of [
      "terminal-collapse",
      "terminal-expand",
      "terminal-resize",
      "terminal-drawer-open",
      "terminal-drawer-close",
    ]) {
      expect(markup).toContain(`id="${id}"`);
    }
    expect(markup).toContain('aria-label="Collapse the terminal"');
    expect(markup).toContain('class="terminal-dot"');
  });

  it("restores the sidebar preference in the head, before first paint", () => {
    const markup = renderStudioDocument({ ...selected, terminal });
    const head = markup.slice(0, markup.indexOf("</head>"));
    expect(head).toContain("mate-studio-terminal-width");
    expect(head).toContain("mate-studio-terminal-collapsed");
  });

  it("loads only Studio-served client files with the terminal", () => {
    const markup = renderStudioDocument({ ...selected, terminal });
    const sources = [...markup.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) expect(source!.startsWith("/studio/terminal/")).toBe(true);
    expect(markup).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it("offers only launchable agents and names the target", () => {
    const markup = renderStudioDocument({ ...selected, terminal });
    expect(markup).toContain('data-terminal-start="claude"');
    expect(markup).not.toContain('data-terminal-start="opencode"');
    expect(markup).toContain(`Launches against <code>${acme}</code>`);
    expect(markup).not.toContain("fixed when Studio started");
  });

  it("marks a pinned target and says when nothing can launch", () => {
    const pinned = renderStudioDocument({
      ...selected,
      terminal: { ...terminal, pinned: true, agents: [] },
    });
    expect(pinned).toContain("fixed when Studio started");
    expect(pinned).toContain("No agent this companion allows is installed.");
    expect(pinned).not.toContain("data-terminal-start=");
  });

  it("reconnects a bounded number of times and never after a takeover", () => {
    const markup = renderStudioDocument({ ...selected, terminal });
    expect(markup).toContain("MAX_ATTEMPTS = 8");
    expect(markup).toContain("FIRST_DELAY = 2000");
    expect(markup).toContain("if (takenOver) return;");
    expect(markup).toContain("sessionStorage");
  });
});

describe("hosted reports view", () => {
  const reports = page({
    ...selected,
    selection: { ...selected.selection, view: "reports" },
  });

  it("renders a sandboxed frame without same-origin, an open-in-new-tab action and an empty note", () => {
    const markup = renderStudioDocument(reports);
    expect(markup).toContain('sandbox="allow-scripts allow-modals"');
    expect(markup).not.toContain("allow-same-origin");
    expect(markup).toContain("Open in new tab");
    expect(markup).toContain("No hosted reports yet.");
    expect(markup).toContain('id="reports-item-template"');
    expect(markup).toContain("<h1>Reports</h1>");
  });

  it("offers an addressable Reports view with a badge that starts hidden", () => {
    const markup = renderStudioDocument(selected);
    const form = viewForm(markup, "reports");
    expect(form).toContain('name="view" value="reports"');
    expect(form).toMatch(/id="reports-badge"[^>]*hidden/);
  });

  it("names the shown companion's report channel on the shell, and none without one", () => {
    const shell = renderStudioDocument(selected);
    expect(shell).toContain(`data-reports-url="/api/reports?companion=${digest}"`);
    expect(shell).toContain(
      `data-reports-events-url="/api/vault/changes?companion=${digest}&amp;scope=reports"`,
    );
    expect(shell).toContain('data-reports-view-url="/?');
    expect(shell).toContain("view=reports");
    expect(shell).toContain('id="reports-toast"');

    const none = renderStudioDocument(page());
    expect(none).not.toContain(`data-reports-events-url="`);
  });
});
