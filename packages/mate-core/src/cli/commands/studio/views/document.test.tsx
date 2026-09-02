import { describe, expect, it } from "bun:test";

import { companionDigest } from "../selection";
import { renderStudioDocument } from "./document";
import { formatCollectedAt, type StudioPage } from "./model";

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
      expect(markup).not.toContain('id="studio-change"');
      expect(markup).toContain('id="studio-theme"');
      expect(markup).toContain('id="studio-toast"');
    }
  });

  it("asks for a companion when none is named", () => {
    const markup = renderStudioDocument(page());
    expect(markup).toContain("Select a Companion Repository.");
    expect(markup).not.toContain("<h3>Changes</h3>");
  });

  it("presents the named companion's Dashboard", () => {
    const markup = renderStudioDocument(selected);
    expect(markup).toContain("<h3>Changes</h3>");
    expect(markup).toContain("<h3>Specs by Area</h3>");
    expect(markup).toContain("add-auth");
    expect(markup).toContain('aria-pressed="true"');
  });

  it("presents the Workflow view when the URL names it", () => {
    const markup = renderStudioDocument({
      ...selected,
      selection: { ...selected.selection, view: "workflow" },
    });
    expect(markup).toContain("<h2>Workflow</h2>");
    expect(markup).not.toContain('id="studio-change"');
    expect(markup).not.toContain("<h3>Changes</h3>");
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
