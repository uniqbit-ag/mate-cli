import { describe, expect, test } from "bun:test";
import { renderJSON, renderMarkdown } from "./renderer";
import type { ReportData } from "./types";

const makeReport = (overrides: Partial<ReportData> = {}): ReportData => ({
  days: 7,
  generatedAt: "2025-01-15T12:00:00Z",
  workingRepoPath: "/tmp/work",
  companionRepoPath: "/tmp/companion",
  activeAgents: ["claude", "opencode"],
  enabledCapabilities: ["tokensave", "headroom"],
  spending: [
    {
      model: "claude-sonnet-5",
      inputTokens: 100000,
      outputTokens: 50000,
      cacheReadTokens: 20000,
      cacheWriteTokens: 10000,
      cost: 12.5,
    },
    {
      model: "gpt-5.4",
      inputTokens: 200000,
      outputTokens: 100000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 25.0,
    },
  ],
  savings: [
    { tool: "tokensave", tokensSaved: 500000, calls: 50, costSaved: 5.0, efficiency: "10K/call" },
    { tool: "headroom", tokensSaved: 1000000, calls: 100, costSaved: 10.0, efficiency: "10K/call" },
  ],
  toolStatus: [
    { name: "ccusage", enabled: true, status: "ok" },
    { name: "tokensave", enabled: true, status: "ok" },
    { name: "headroom", enabled: true, status: "ok" },
  ],
  totalSpending: 37.5,
  totalSavings: 15.0,
  netSpend: 22.5,
  ...overrides,
});

describe("renderMarkdown", () => {
  test("renders header with report metadata", () => {
    const md = renderMarkdown(makeReport());
    expect(md).toContain("# Token Usage Report");
    expect(md).toContain("Last 7 days");
    expect(md).toContain("Capabilities");
    expect(md).toContain("tokensave");
    expect(md).toContain("headroom");
  });

  test("renders spending table", () => {
    const md = renderMarkdown(makeReport());
    expect(md).toContain("## Spending");
    expect(md).toContain("Model");
    expect(md).toContain("Cost (est.)");
    expect(md).toContain("claude-sonnet-5");
    expect(md).toContain("$12.50");
    expect(md).toContain("$25.00");
    expect(md).not.toContain("Source");
  });

  test("renders savings table", () => {
    const md = renderMarkdown(makeReport());
    expect(md).toContain("## Savings");
    expect(md).toContain("tokensave");
    expect(md).toContain("headroom");
  });

  test("renders tool status table", () => {
    const md = renderMarkdown(makeReport());
    expect(md).toContain("## Tool Status");
    expect(md).toContain("ccusage");
    expect(md).toContain("headroom");
  });

  test("renders summary with totals", () => {
    const md = renderMarkdown(makeReport());
    expect(md).toContain("## Summary");
    expect(md).toContain("$37.50");
    expect(md).toContain("$15.00");
    expect(md).toContain("$22.50");
  });

  test("does not render TokenSave Counter", () => {
    const md = renderMarkdown(makeReport());
    expect(md).not.toContain("TokenSave Counter");
  });

  test("does not render By Category section", () => {
    const md = renderMarkdown(makeReport());
    expect(md).not.toContain("## By Category");
  });

  test("does not render OpenCode Tool Usage section", () => {
    const md = renderMarkdown(makeReport());
    expect(md).not.toContain("## OpenCode Tool Usage");
  });

  test("does not render Project Context section", () => {
    const md = renderMarkdown(makeReport());
    expect(md).not.toContain("## Project Context");
  });

  test("handles empty spending gracefully", () => {
    const md = renderMarkdown(makeReport({ spending: [] }));
    expect(md).toContain("## Spending");
    expect(md).toContain("No spending data available");
  });

  test("handles empty savings gracefully", () => {
    const md = renderMarkdown(makeReport({ savings: [] }));
    expect(md).toContain("## Savings");
    expect(md).toContain("No savings data available");
  });

  test("renders N/A for zero tokens saved and zero cost saved", () => {
    const md = renderMarkdown(
      makeReport({
        savings: [{ tool: "tokensave", tokensSaved: 0, calls: 0, costSaved: 0, efficiency: "n/a" }],
      }),
    );
    expect(md).not.toContain("$0.00");
    expect(md.match(/N\/A/g)).toHaveLength(2);
  });

  test("renders a blank line above the Summary headline", () => {
    const md = renderMarkdown(makeReport());
    expect(md).toContain("\n\n## Summary");
  });
});

describe("renderJSON", () => {
  test("serializes report data as JSON", () => {
    const data = makeReport();
    const json = renderJSON(data);
    const parsed = JSON.parse(json);
    expect(parsed.days).toBe(7);
    expect(parsed.spending).toHaveLength(2);
    expect(parsed.savings).toHaveLength(2);
    expect(parsed.totalSpending).toBe(37.5);
  });

  test("includes all fields", () => {
    const data = makeReport();
    const json = renderJSON(data);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty("days");
    expect(parsed).toHaveProperty("generatedAt");
    expect(parsed).toHaveProperty("workingRepoPath");
    expect(parsed).toHaveProperty("companionRepoPath");
    expect(parsed).toHaveProperty("spending");
    expect(parsed).toHaveProperty("savings");
    expect(parsed).toHaveProperty("toolStatus");
    expect(parsed).toHaveProperty("totalSpending");
    expect(parsed).toHaveProperty("totalSavings");
    expect(parsed).toHaveProperty("netSpend");
  });
});
