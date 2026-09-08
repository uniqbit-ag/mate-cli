/** @jsxImportSource hono/jsx */

import { describe, expect, it } from "bun:test";

import type { StudioInventory } from "../inventory";
import { companionDigest, type StudioSelection } from "../selection";
import { CompanionPicker } from "./companion-picker";

const dashboard: StudioSelection = { companionDigest: null, view: "dashboard", refresh: false };

function render(inventory: StudioInventory, selection: StudioSelection = dashboard): string {
  return String(<CompanionPicker inventory={inventory} selection={selection} />);
}

const acme = "/home/dev/.mate/companions/acme-companion";
const beta = "/home/dev/.mate/companions/beta-companion";

describe("CompanionPicker", () => {
  it("offers one card per companion, each naming its own digest", () => {
    const markup = render({
      companions: [
        { path: acme, health: "ready", pairings: [] },
        { path: beta, health: "ready", pairings: [] },
      ],
    });
    expect(markup.match(/class="picker-card"/g)).toHaveLength(2);
    expect(markup).toContain(`name="companion" value="${companionDigest(acme)}"`);
    expect(markup).toContain(`name="companion" value="${companionDigest(beta)}"`);
  });

  it("leads a card with the companion's own name and keeps its full path", () => {
    const markup = render({ companions: [{ path: acme, health: "ready", pairings: [] }] });
    expect(markup).toContain('<span class="picker-card-name">acme-companion</span>');
    expect(markup).toContain(acme);
  });

  it("chooses by navigation and carries the active view", () => {
    const markup = render(
      { companions: [{ path: acme, health: "ready", pairings: [] }] },
      { ...dashboard, view: "workflow" },
    );
    expect(markup).toContain('method="get" action="/"');
    expect(markup).toContain('<input type="hidden" name="view" value="workflow"/>');
  });

  it("marks a companion that is not ready and states its reason", () => {
    const markup = render({
      companions: [
        { path: acme, health: "degraded", diagnostic: "openspec root missing", pairings: [] },
      ],
    });
    expect(markup).toContain('data-unready="true"');
    expect(markup).toContain("degraded — openspec root missing");
  });

  it("lists the linked working repositories and counts the rest", () => {
    const markup = render({
      companions: [
        {
          path: acme,
          health: "ready",
          pairings: ["one", "two", "three", "four"].map((id) => ({
            repositoryId: id,
            repositoryPath: `/home/dev/code/${id}`,
            health: "ready" as const,
            ambiguous: false,
          })),
        },
      ],
    });
    expect(markup).toContain(">one<");
    expect(markup).toContain(">three<");
    expect(markup).not.toContain(">four<");
    expect(markup).toContain("+1 more");
  });

  it("says so when a companion has no linked working repository", () => {
    const markup = render({ companions: [{ path: acme, health: "ready", pairings: [] }] });
    expect(markup).toContain("no linked working repository");
  });

  it("states how to register one when nothing is registered", () => {
    const markup = render({ companions: [] });
    expect(markup).toContain("No Companion Repository is registered on this machine.");
    expect(markup).toContain("mate companion setup");
    expect(markup).not.toContain("picker-card");
  });

  it("renders a path containing markup characters as text", () => {
    const markup = render({
      companions: [{ path: "/tmp/<script>x</script>", health: "ready", pairings: [] }],
    });
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });
});
