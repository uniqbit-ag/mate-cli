/** @jsxImportSource hono/jsx */

import { describe, expect, it } from "bun:test";

import type { StudioInventory } from "../inventory";
import { companionDigest, type StudioSelection } from "../selection";
import { CompanionSelector } from "./companion-selector";

const dashboard: StudioSelection = { companionDigest: null, view: "dashboard", refresh: false };

function render(inventory: StudioInventory, selection: StudioSelection = dashboard): string {
  return String(<CompanionSelector inventory={inventory} selection={selection} />);
}

const acme = "/home/dev/.mate/companions/acme-companion";
const beta = "/home/dev/.mate/companions/beta-companion";

describe("CompanionSelector", () => {
  it("lists every registered companion by digest", () => {
    const markup = render({
      companions: [
        { path: acme, health: "ready", pairings: [] },
        { path: beta, health: "ready", pairings: [] },
      ],
    });
    expect(markup).toContain(`value="${companionDigest(acme)}"`);
    expect(markup).toContain(`value="${companionDigest(beta)}"`);
    expect(markup).toContain(acme);
    expect(markup).toContain(beta);
  });

  it("de-emphasizes a companion that is not ready and shows its reason", () => {
    const markup = render({
      companions: [
        { path: acme, health: "degraded", diagnostic: "openspec root missing", pairings: [] },
      ],
    });
    expect(markup).toContain('class="unready"');
    expect(markup).toContain('data-unready="true"');
    expect(markup).toContain("degraded — openspec root missing");
  });

  it("populates the selector when every companion is unready", () => {
    const markup = render({
      companions: [
        { path: acme, health: "degraded", pairings: [] },
        { path: beta, health: "degraded", pairings: [] },
      ],
    });
    expect(markup).not.toContain("no companion registered");
    expect(markup.match(/<option/g)).toHaveLength(2);
  });

  it("marks the selected companion and states its reason", () => {
    const markup = render(
      {
        companions: [{ path: acme, health: "degraded", diagnostic: "no git remote", pairings: [] }],
      },
      { ...dashboard, companionDigest: companionDigest(acme) },
    );
    expect(markup).toContain('selected=""');
    expect(markup).toContain('<p class="note unready">degraded — no git remote</p>');
  });

  it("submits when the companion changes and keeps the active view", () => {
    const markup = render(
      { companions: [{ path: acme, health: "ready", pairings: [] }] },
      { ...dashboard, view: "workflow" },
    );
    expect(markup).toContain('method="get" action="/"');
    expect(markup).toContain('onchange="this.form.submit()"');
    expect(markup).toContain('<input type="hidden" name="view" value="workflow"/>');
    expect(markup).not.toContain("Open companion");
  });

  it("states when nothing is registered", () => {
    const markup = render({ companions: [] });
    expect(markup).toContain("no companion registered");
    expect(markup).toContain("No Companion Repository is registered on this machine.");
  });

  it("renders a path containing markup characters as text", () => {
    const markup = render({
      companions: [{ path: "/tmp/<script>x</script>", health: "ready", pairings: [] }],
    });
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });
});
