import { formatCost, formatTokens } from "./formatter";
import type {
  ReportData,
  ReportDocument,
  ReportKeyValue,
  ReportMetric,
  ReportSection,
  ReportStatusTone,
} from "./types";
import { REPORT_DOCUMENT_VERSION } from "./types";

/** Collector status strings mapped to tones, so the built-in report never relies on inference. */
const TOOL_STATUS_TONES: Record<string, ReportStatusTone> = {
  ok: "ok",
  "no data": "warn",
  "no window data": "warn",
  "not installed": "neutral",
  "not enabled": "neutral",
};

export function reportDataToDocument(data: ReportData): ReportDocument {
  const metadata: ReportKeyValue[] = [
    { label: "Working repository", value: data.workingRepoPath },
    { label: "Companion repository", value: data.companionRepoPath },
    { label: "Active agents", value: data.activeAgents.join(", ") || "None" },
    { label: "Capabilities", value: data.enabledCapabilities.join(", ") || "None" },
  ];
  const summary: ReportMetric[] = [
    { label: "Total spending", value: formatCost(data.totalSpending) },
    { label: "Total savings", value: formatCost(data.totalSavings) },
    { label: "Net spend", value: formatCost(data.netSpend) },
  ];
  const sections: ReportSection[] = [
    {
      id: "spending",
      title: "Spending",
      type: "table",
      columns: ["Model", "Input", "Output", "Cache Read", "Cache Write", "Cost (est.)"],
      rows: data.spending.map((entry) => [
        entry.model,
        formatTokens(entry.inputTokens),
        formatTokens(entry.outputTokens),
        formatTokens(entry.cacheReadTokens),
        formatTokens(entry.cacheWriteTokens),
        formatCost(entry.cost),
      ]),
    },
    {
      id: "savings",
      title: "Savings",
      type: "table",
      columns: ["Tool", "Tokens Saved", "Calls", "Cost Saved", "Efficiency"],
      rows: data.savings.map((entry) => [
        entry.tool,
        entry.tokensSaved === 0 ? "N/A" : formatTokens(entry.tokensSaved),
        String(entry.calls),
        entry.costSaved === 0 ? "N/A" : formatCost(entry.costSaved),
        entry.efficiency,
      ]),
    },
    {
      id: "tool-status",
      title: "Tool Status",
      type: "statuses",
      items: data.toolStatus.map((entry) => ({
        label: entry.name,
        status: entry.status,
        tone: TOOL_STATUS_TONES[entry.status] ?? "neutral",
      })),
    },
  ];

  return {
    version: REPORT_DOCUMENT_VERSION,
    title: "Token Usage Report",
    generatedAt: data.generatedAt,
    period: `Last ${data.days} days`,
    metadata,
    summary,
    sections,
  };
}
