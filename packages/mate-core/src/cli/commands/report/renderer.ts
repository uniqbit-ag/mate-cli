import type { ReportData } from "./types";
import { formatCost, formatTokens } from "./formatter";

function renderTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return `| ${headers.join(" | ")} |\n`;
  }

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );

  const renderRow = (row: string[]): string =>
    `| ${row.map((value, index) => value.padEnd(widths[index])).join(" | ")} |`;

  const divider = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [renderRow(headers), divider, ...rows.map(renderRow)].join("\n");
}

function renderKeyValueTable(rows: Array<[string, string]>): string {
  return renderTable(["Field", "Value"], rows);
}

function printSection(title: string, body: string): string {
  return `${title}\n\n${body}\n`;
}

export function renderMarkdown(data: ReportData): string {
  const sections: string[] = [];

  // Header
  sections.push(`# Token Usage Report\n`);
  sections.push(
    renderKeyValueTable([
      ["Window", `Last ${data.days} days`],
      ["Generated", data.generatedAt],
      ["Capabilities", data.enabledCapabilities.join(", ") || "None"],
    ]),
  );

  // Summary
  sections.push(
    "\n" +
      printSection(
        "## Summary",
        renderKeyValueTable([
          ["Total Spending", formatCost(data.totalSpending)],
          ["Total Savings", formatCost(data.totalSavings)],
          ["Net Spend", formatCost(data.netSpend)],
        ]),
      ),
  );

  // Spending
  if (data.spending.length > 0) {
    const spendingRows = data.spending.map((entry) => [
      entry.model,
      formatTokens(entry.inputTokens),
      formatTokens(entry.outputTokens),
      formatTokens(entry.cacheReadTokens),
      formatTokens(entry.cacheWriteTokens),
      formatCost(entry.cost),
    ]);
    sections.push(
      printSection(
        "## Spending",
        renderTable(
          ["Model", "Input", "Output", "Cache Read", "Cache Write", "Cost (est.)"],
          spendingRows,
        ),
      ),
    );
  } else {
    sections.push(printSection("## Spending", "No spending data available."));
  }

  // Savings
  if (data.savings.length > 0) {
    const savingsRows = data.savings.map((entry) => [
      entry.tool,
      entry.tokensSaved === 0 ? "N/A" : formatTokens(entry.tokensSaved),
      String(entry.calls),
      entry.costSaved === 0 ? "N/A" : formatCost(entry.costSaved),
      entry.efficiency,
    ]);
    sections.push(
      printSection(
        "## Savings",
        renderTable(["Tool", "Tokens Saved", "Calls", "Cost Saved", "Efficiency"], savingsRows),
      ),
    );
  } else {
    sections.push(printSection("## Savings", "No savings data available."));
  }

  // Tool Status
  const toolStatusRows = data.toolStatus.map((entry) => {
    const icon = entry.enabled ? "✅" : "⏸️";
    return [entry.name, `${icon} ${entry.status}`];
  });
  sections.push(printSection("## Tool Status", renderTable(["Tool", "Status"], toolStatusRows)));

  return sections.join("\n");
}

export function renderJSON(data: ReportData): string {
  return JSON.stringify(data, null, 2);
}
