/** @jsxImportSource hono/jsx */

import { describe, expect, it } from "bun:test";

import type { StudioCompanionPayload, StudioShippedChange } from "../../payload";
import type { StudioSelection } from "../../selection";
import type { StudioReportSummary } from "../model";
import { AnalystOverview, recentlyChangedSpecs } from "./index";

const selection: StudioSelection = {
  companionDigest: "0123456789",
  role: "business-analyst",
  view: "dashboard",
  refresh: false,
};

function shipped(anchor: string, specs: string[], hasProposal = true): StudioShippedChange {
  return { name: anchor.slice(11), anchor, archivedOn: anchor.slice(0, 10), specs, hasProposal };
}

function payload(overrides: Partial<StudioCompanionPayload> = {}): StudioCompanionPayload {
  return {
    companionPath: "/home/dev/.mate/companions/acme-companion",
    changes: [
      {
        name: "add-active-work",
        completedTasks: 2,
        totalTasks: 5,
        status: "in-progress",
        artifacts: [{ id: "tasks" }],
      },
    ],
    specs: [
      { capability: "acme-login", areas: ["acme"], requirementCount: 3, valid: true },
      { capability: "acme-billing", areas: ["acme", "docs"], requirementCount: 4, valid: false },
    ],
    shipped: [
      shipped("2026-02-10-acme-checkout", ["acme-billing", "acme-login"]),
      shipped("2026-01-05-acme-minimal", ["acme-login"], false),
    ],
    skills: ["mate-grill-me"],
    skillInventory: { claude: ["mate-grill-me"], opencode: [], agents: [] },
    topology: null,
    warnings: [],
    ...overrides,
  };
}

const reports: StudioReportSummary[] = [
  { id: "a".repeat(32), title: "Acme quarterly review", createdAt: Date.UTC(2026, 1, 3, 9, 0) },
];

function render(data = payload(), listed: StudioReportSummary[] | null = reports): string {
  return String(<AnalystOverview payload={data} selection={selection} reports={listed} />);
}

function hrefs(markup: string): URL[] {
  return [...markup.matchAll(/href="([^"]*)"/g)].map(
    ([, href]) => new URL(href.replaceAll("&amp;", "&"), "http://localhost:1"),
  );
}

describe("AnalystOverview", () => {
  it("presents the four parts", () => {
    const markup = render();
    expect(markup).toContain("What the system does");
    expect(markup).toContain("Recently shipped");
    expect(markup).toContain("Recently changed specs");
    expect(markup).toContain("Recent reports");
    expect(markup).toContain("Acme quarterly review");
  });

  it("counts capabilities, requirements, and invalid specs, and capabilities per Area", () => {
    const markup = render();
    expect(markup).toContain("<dt>capabilities</dt><dd>2</dd>");
    expect(markup).toContain("<dt>requirements</dt><dd>7</dd>");
    expect(markup).toContain('data-alert="true"><dt>invalid specs</dt><dd>1</dd>');
    expect(markup).toMatch(/acme<\/span><span class="analyst-count">2</);
    expect(markup).toMatch(/docs<\/span><span class="analyst-count">1</);
  });

  it("lists shipped changes newest first with date and capabilities", () => {
    const markup = render();
    expect(markup.indexOf("acme-checkout")).toBeLessThan(markup.indexOf("acme-minimal"));
    expect(markup).toContain("archived 2026-02-10");
    expect(markup).toContain("acme-billing, acme-login");
  });

  it("names each changed spec once, at its newest shipped change", () => {
    expect(recentlyChangedSpecs(payload().shipped)).toEqual([
      { capability: "acme-billing", change: "acme-checkout", archivedOn: "2026-02-10" },
      { capability: "acme-login", change: "acme-checkout", archivedOn: "2026-02-10" },
    ]);
  });

  it("caps each list", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      shipped(`2026-01-${String(index + 10)}-acme-${index}`, [`acme-spec-${index}`]),
    );
    const listedReports = Array.from({ length: 7 }, (_, index) => ({
      id: String(index).repeat(32),
      title: `Report ${index}`,
      createdAt: index,
    }));
    const markup = render(payload({ shipped: many }), listedReports);
    const rows = (id: string) =>
      (new RegExp(`aria-labelledby="${id}"[\\s\\S]*?</section>`).exec(markup)?.[0] ?? "").split(
        'class="analyst-row"',
      ).length - 1;
    expect(rows("analyst-shipped")).toBe(8);
    expect(rows("analyst-changed-specs")).toBe(10);
    expect(rows("analyst-reports")).toBe(5);
    expect(markup).toContain("newest 8 of 12");
  });

  it("links into the vault, Specs, and Reports, keeping the role", () => {
    const links = hrefs(render());
    for (const link of links) expect(link.searchParams.get("role")).toBe("business-analyst");
    const targets = links.map((link) => [
      link.searchParams.get("view"),
      link.searchParams.get("path") ?? link.searchParams.get("dir"),
    ]);
    expect(targets).toContainEqual(["specs", null]);
    expect(targets).toContainEqual(["reports", null]);
    expect(targets).toContainEqual([
      "vault",
      "openspec/changes/archive/2026-02-10-acme-checkout/proposal.md",
    ]);
    expect(targets).toContainEqual(["vault", "openspec/changes/archive/2026-01-05-acme-minimal"]);
    expect(targets).toContainEqual(["vault", "openspec/specs/acme-billing/spec.md"]);
  });

  it("shows no active change, task, workflow, or skill content", () => {
    const markup = render();
    expect(markup).not.toContain("add-active-work");
    expect(markup).not.toContain("2 / 5");
    expect(markup).not.toContain("mate-grill-me");
    expect(markup).not.toContain("progressbar");
  });

  it("gives each empty part a no-data message", () => {
    const markup = render(payload({ specs: [], shipped: [] }), []);
    expect(markup).toContain("No specs published in this companion.");
    expect(markup).toContain("No shipped changes yet.");
    expect(markup).toContain("No specs changed by shipped changes yet.");
    expect(markup).toContain("No hosted reports yet.");
    expect(render(payload(), null)).toContain("Reports could not be listed.");
  });
});
