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

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function renderHTMLTable(headers: string[], rows: string[][]): string {
  const headerHTML = headers.map((header) => `<th scope="col">${escapeHTML(header)}</th>`).join("");
  const rowsHTML = rows.length
    ? rows
        .map((row) => `<tr>${row.map((value) => `<td>${escapeHTML(value)}</td>`).join("")}</tr>`)
        .join("")
    : "";
  return `<div class="table-wrap"><table><thead><tr>${headerHTML}</tr></thead><tbody>${rowsHTML}</tbody></table></div>`;
}

function renderHTMLSection(id: string, title: string, body: string): string {
  return `<section id="${id}"><h2>${title}</h2>${body}</section>`;
}

export function renderHTML(data: ReportData): string {
  const spending = data.spending.length
    ? renderHTMLTable(
        ["Model", "Input", "Output", "Cache Read", "Cache Write", "Cost (est.)"],
        data.spending.map((entry) => [
          entry.model,
          formatTokens(entry.inputTokens),
          formatTokens(entry.outputTokens),
          formatTokens(entry.cacheReadTokens),
          formatTokens(entry.cacheWriteTokens),
          formatCost(entry.cost),
        ]),
      )
    : '<p class="empty">No spending data available.</p>';

  const savings = data.savings.length
    ? renderHTMLTable(
        ["Tool", "Tokens Saved", "Calls", "Cost Saved", "Efficiency"],
        data.savings.map((entry) => [
          entry.tool,
          entry.tokensSaved === 0 ? "N/A" : formatTokens(entry.tokensSaved),
          String(entry.calls),
          entry.costSaved === 0 ? "N/A" : formatCost(entry.costSaved),
          entry.efficiency,
        ]),
      )
    : '<p class="empty">No savings data available.</p>';

  const toolStatus = renderHTMLTable(
    ["Tool", "Status"],
    data.toolStatus.map((entry) => [entry.name, entry.status]),
  );

  const metadata = renderHTMLTable(
    ["Field", "Value"],
    [
      ["Window", `Last ${data.days} days`],
      ["Generated", data.generatedAt],
      ["Working repository", data.workingRepoPath],
      ["Companion repository", data.companionRepoPath],
      ["Active agents", data.activeAgents.join(", ") || "None"],
      ["Capabilities", data.enabledCapabilities.join(", ") || "None"],
    ],
  );

  const summary = renderHTMLTable(
    ["Metric", "Value"],
    [
      ["Total spending", formatCost(data.totalSpending)],
      ["Total savings", formatCost(data.totalSavings)],
      ["Net spend", formatCost(data.netSpend)],
    ],
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Token Usage Report</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; background: #f4f6f8; color: #18212b; }
    body { margin: 0; }
    .report { max-width: 1120px; margin: 0 auto; padding: 32px 20px 56px; }
    header, section { background: #fff; border: 1px solid #dce2e8; border-radius: 14px; margin-bottom: 20px; padding: 24px; box-shadow: 0 8px 24px rgb(24 33 43 / 6%); }
    h1, h2 { margin-top: 0; }
    h1 { margin-bottom: 8px; }
    h2 { font-size: 1.15rem; }
    .eyebrow { color: #536273; font-size: .8rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; min-width: 100%; }
    th, td { border-bottom: 1px solid #e8edf1; padding: 10px 12px; text-align: left; vertical-align: top; }
    th { color: #536273; font-size: .8rem; text-transform: uppercase; }
    .empty { color: #536273; margin: 0; }
    @media (max-width: 640px) { .report { padding: 16px 12px 32px; } header, section { padding: 16px; } }
  </style>
</head>
<body>
  <main class="report" data-working-repository="${escapeHTML(data.workingRepoPath)}" data-companion-repository="${escapeHTML(data.companionRepoPath)}">
    <header>
      <p class="eyebrow">Mate report</p>
      <h1>Token Usage Report</h1>
      ${metadata}
    </header>
    ${renderHTMLSection("summary", "Summary", summary)}
    ${renderHTMLSection("spending", "Spending", spending)}
    ${renderHTMLSection("savings", "Savings", savings)}
    ${renderHTMLSection("tool-status", "Tool Status", toolStatus)}
  </main>
</body>
</html>`;
}
