import { reportDataToDocument } from "./adapter";
import { validateReportDocument } from "./contract";
import type {
  ReportData,
  ReportDocument,
  ReportKeyValue,
  ReportSection,
  ReportValue,
} from "./types";

type RenderInput = ReportDocument | ReportData;

function isReportDocument(input: RenderInput): input is ReportDocument {
  return "version" in input;
}

function normalize(input: RenderInput): ReportDocument {
  return validateReportDocument(isReportDocument(input) ? input : reportDataToDocument(input));
}

function valueToString(value: ReportValue): string {
  if (value === null) return "N/A";
  return String(value);
}

function renderTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return `| ${headers.join(" | ")} |`;

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const renderRow = (row: string[]): string =>
    `| ${row.map((value, index) => value.padEnd(widths[index])).join(" | ")} |`;
  const divider = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [renderRow(headers), divider, ...rows.map(renderRow)].join("\n");
}

function renderKeyValueTable(rows: ReportKeyValue[]): string {
  return renderTable(
    ["Field", "Value"],
    rows.map((row) => [row.label, valueToString(row.value)]),
  );
}

function printSection(title: string, body: string): string {
  return `${title}\n\n${body}\n`;
}

function emptyTableMessage(title: string): string {
  const normalized = title.toLowerCase();
  return normalized === "spending" || normalized === "savings"
    ? `No ${normalized} data available.`
    : "No data available.";
}

function sectionMarkdown(section: ReportSection): string {
  switch (section.type) {
    case "metadata":
    case "key-value":
      return renderKeyValueTable(section.items);
    case "metrics":
      return renderTable(
        ["Metric", "Value"],
        section.items.map((item) => [item.label, valueToString(item.value)]),
      );
    case "table":
      return section.rows.length
        ? renderTable(
            section.columns,
            section.rows.map((row) => row.map(valueToString)),
          )
        : emptyTableMessage(section.title);
    case "statuses":
      return section.items.length
        ? renderTable(
            ["Status", "Value"],
            section.items.map((item) => [
              item.label,
              item.detail ? `${item.status}: ${item.detail}` : item.status,
            ]),
          )
        : "No data available.";
    case "text":
      return section.content;
  }
}

export function renderMarkdown(input: RenderInput): string {
  const data = normalize(input);
  const sections: string[] = [`# ${data.title}\n`];
  const metadata = [...data.metadata];
  if (data.period) metadata.unshift({ label: "Period", value: data.period });
  if (data.context) metadata.push({ label: "Context", value: data.context });
  sections.push(renderKeyValueTable(metadata));
  sections.push(
    "\n" +
      printSection(
        "## Summary",
        renderTable(
          ["Metric", "Value"],
          data.summary.map((item) => [item.label, valueToString(item.value)]),
        ),
      ),
  );
  for (const section of data.sections) {
    sections.push(printSection(`## ${section.title}`, sectionMarkdown(section)));
  }
  return sections.join("\n");
}

export function renderJSON(input: RenderInput): string {
  if (!isReportDocument(input)) return JSON.stringify(input, null, 2);
  return JSON.stringify(normalize(input), null, 2);
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

function emptyHTML(message: string): string {
  return `<p class="empty">${escapeHTML(message)}</p>`;
}

function renderHTMLKeyValues(items: ReportKeyValue[]): string {
  return items.length
    ? renderHTMLTable(
        ["Field", "Value"],
        items.map((item) => [item.label, valueToString(item.value)]),
      )
    : emptyHTML("No metadata available.");
}

function renderHTMLSectionBody(section: ReportSection): string {
  switch (section.type) {
    case "metadata":
    case "key-value":
      return renderHTMLKeyValues(section.items);
    case "metrics":
      return section.items.length
        ? renderHTMLTable(
            ["Metric", "Value"],
            section.items.map((item) => [item.label, valueToString(item.value)]),
          )
        : emptyHTML("No metrics available.");
    case "table":
      return section.rows.length
        ? renderHTMLTable(
            section.columns,
            section.rows.map((row) => row.map(valueToString)),
          )
        : emptyHTML(emptyTableMessage(section.title));
    case "statuses":
      return section.items.length
        ? renderHTMLTable(
            ["Status", "Value"],
            section.items.map((item) => [
              item.label,
              item.detail ? `${item.status}: ${item.detail}` : item.status,
            ]),
          )
        : emptyHTML("No status data available.");
    case "text":
      return section.content
        ? `<p class="report-text">${escapeHTML(section.content).replaceAll("\n", "<br>")}</p>`
        : emptyHTML("No text available.");
  }
}

function renderHTMLSection(section: ReportSection): string {
  return `<section id="${escapeHTML(section.id)}"><h2>${escapeHTML(section.title)}</h2>${renderHTMLSectionBody(section)}</section>`;
}

export function renderHTML(input: RenderInput): string {
  const data = normalize(input);
  const legacy = isReportDocument(input) ? undefined : input;
  const metadata = [...data.metadata];
  if (data.period) metadata.unshift({ label: "Period", value: data.period });
  if (data.context) metadata.push({ label: "Context", value: data.context });
  const summary: ReportMetricsSection = {
    id: "summary",
    title: "Summary",
    type: "metrics",
    items: data.summary,
  };

  const repositoryAttributes = legacy
    ? ` data-working-repository="${escapeHTML(legacy.workingRepoPath)}" data-companion-repository="${escapeHTML(legacy.companionRepoPath)}"`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHTML(data.title)}</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; background: #f4f6f8; color: #18212b; }
    body { margin: 0; }
    .report { max-width: 1120px; margin: 0 auto; padding: 32px 20px 56px; }
    header, section { background: #fff; border: 1px solid #dce2e8; border-radius: 14px; margin-bottom: 20px; padding: 24px; box-shadow: 0 8px 24px rgb(24 33 43 / 6%); }
    h1, h2 { margin-top: 0; }
    h1 { margin-bottom: 8px; }
    h2 { font-size: 1.15rem; }
    .eyebrow { color: #536273; font-size: .8rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .print-control { background: #18212b; border: 0; border-radius: 8px; color: #fff; cursor: pointer; padding: 10px 14px; }
    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; min-width: 100%; }
    th, td { border-bottom: 1px solid #e8edf1; padding: 10px 12px; text-align: left; vertical-align: top; }
    th { color: #536273; font-size: .8rem; text-transform: uppercase; }
    .empty { color: #536273; margin: 0; }
    @media (max-width: 640px) { .report { padding: 16px 12px 32px; } header, section { padding: 16px; } }
    @media print {
      :root, body { background: #fff; color: #000; }
      .report { max-width: none; padding: 0; }
      header, section { border: 0; border-radius: 0; box-shadow: none; margin-bottom: 16px; padding: 0; }
      .print-control, .interactive-only { display: none !important; }
      .table-wrap { overflow: visible; }
      table { width: 100%; }
      th, td { color: #000; }
    }
  </style>
</head>
<body>
  <main class="report" data-report-version="${data.version}"${repositoryAttributes}>
    <header>
      <p class="eyebrow">Mate report</p>
      <h1>${escapeHTML(data.title)}</h1>
      ${renderHTMLKeyValues(metadata)}
      <button class="print-control interactive-only" type="button" onclick="window.print()">Print / Save as PDF</button>
    </header>
    ${renderHTMLSection(summary)}
    ${data.sections.map(renderHTMLSection).join("\n    ")}
  </main>
</body>
</html>`;
}

type ReportMetricsSection = Extract<ReportSection, { type: "metrics" }>;

export { escapeHTML };
