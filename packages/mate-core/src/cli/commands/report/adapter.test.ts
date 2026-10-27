import { describe, expect, test } from "bun:test";

import { reportDataToDocument } from "./adapter";
import { renderHTML } from "./renderer";
import type { ReportData, ReportStatusesSection } from "./types";

const makeData = (toolStatus: ReportData["toolStatus"]): ReportData => ({
  days: 7,
  generatedAt: "2026-01-01T00:00:00Z",
  workingRepoPath: "/tmp/work",
  companionRepoPath: "/tmp/companion",
  activeAgents: [],
  enabledCapabilities: [],
  spending: [],
  savings: [],
  toolStatus,
  totalSpending: 0,
  totalSavings: 0,
  netSpend: 0,
});

describe("reportDataToDocument", () => {
  test("sets an explicit tone for each collector status", () => {
    const document = reportDataToDocument(
      makeData([
        { name: "ccusage", enabled: true, status: "ok" },
        { name: "tokensave", enabled: false, status: "no data" },
        { name: "rtk", enabled: false, status: "no window data" },
        { name: "lsp", enabled: false, status: "not installed" },
        { name: "graphify", enabled: false, status: "not enabled" },
      ]),
    );
    const statuses = document.sections.find(
      (section): section is ReportStatusesSection => section.type === "statuses",
    );

    expect(statuses?.items.map((item) => item.tone)).toEqual([
      "ok",
      "warn",
      "warn",
      "neutral",
      "neutral",
    ]);
  });

  test("renders tool statuses with the ok, warn, and neutral tones", () => {
    const html = renderHTML(
      makeData([
        { name: "ccusage", enabled: true, status: "ok" },
        { name: "tokensave", enabled: false, status: "no data" },
        { name: "rtk", enabled: false, status: "not installed" },
      ]),
    );

    const row = (tone: string, label: string): string =>
      `data-tone="${tone}"><span class="tone-marker" aria-hidden="true"></span><span class="status-label">${label}</span>`;
    expect(html).toContain(row("ok", "ccusage"));
    expect(html).toContain(row("warn", "tokensave"));
    expect(html).toContain(row("neutral", "rtk"));
  });

  test("keeps the window and generation time in the header fields, not metadata", () => {
    const document = reportDataToDocument(makeData([]));

    expect(document.period).toBe("Last 7 days");
    expect(document.generatedAt).toBe("2026-01-01T00:00:00Z");
    expect(document.metadata.map((item) => item.label)).toEqual([
      "Working repository",
      "Companion repository",
      "Active agents",
      "Capabilities",
    ]);
  });
});
