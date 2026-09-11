import { readFileSync } from "node:fs";
import { join } from "node:path";

import { reportDataToDocument } from "./adapter";
import { validateReportDocument } from "./contract";
import { highlightInline, highlightStyleBlock } from "./highlight";
import type {
  ReportData,
  ReportDiagramSection,
  ReportDiffSection,
  ReportDocument,
  ReportKeyValue,
  ReportSection,
  ReportValue,
} from "./types";

const MERMAID_RUNTIME_PATH = join(
  import.meta.dirname,
  "../../../templates/report-assets/mermaid.min.js",
);

const MERMAID_RUNTIME_ID = "mermaid-runtime";

const CODE_BLOCK_SELECTOR = "pre.report-code";

let mermaidRuntime: string | undefined;

/** A literal `</script` inside the bundle would close the inline element, so it is neutralised. */
function readMermaidRuntime(): string {
  mermaidRuntime ??= readFileSync(MERMAID_RUNTIME_PATH, "utf8").replaceAll(
    "</script",
    String.raw`<\/script`,
  );
  return mermaidRuntime;
}

const carriesMermaid = (sections: ReportSection[]): boolean =>
  sections.some((section) => section.type === "diagram" && section.mermaid !== undefined);

const carriesVisual = (sections: ReportSection[]): boolean =>
  sections.some((section) => section.type === "diagram" || section.type === "diff");

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
    case "diagram":
      return section.mermaid === undefined
        ? fence("", section.text)
        : fence("mermaid", section.mermaid);
    case "diff":
      return section.patch.trim() ? fence("diff", section.patch) : "No data available.";
  }
}

function fence(language: string, content: string): string {
  return `\`\`\`${language}\n${content}\n\`\`\``;
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

type DiffLineKind = "add" | "del" | "context" | "hunk";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

interface DiffFile {
  path?: string;
  lines: DiffLine[];
}

const DIFF_METADATA_PREFIXES = [
  "index ",
  "old mode ",
  "new mode ",
  "new file mode ",
  "deleted file mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
  "Binary files ",
  "GIT binary patch",
];

function gitHeaderPath(line: string): string | undefined {
  const rest = line.slice("diff --git ".length).trim();
  const paired = /^a\/(.+?) b\/(.+)$/.exec(rest);
  return paired ? paired[2] : rest || undefined;
}

/** Strips the `a/` or `b/` prefix and the optional trailing timestamp git may append. */
function fileHeaderPath(value: string): string | undefined {
  const path = value.split("\t")[0].trim();
  if (path === "" || path === "/dev/null") return undefined;
  return path.replace(/^[ab]\//, "");
}

function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/** `---`/`+++` only head a file outside a hunk; inside one they are ordinary changed lines. */
function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let inHunk = false;

  const open = (path?: string): DiffFile => {
    const file: DiffFile = { path, lines: [] };
    files.push(file);
    return file;
  };

  for (const line of patch.replace(/\n+$/, "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = open(gitHeaderPath(line));
      inHunk = false;
      continue;
    }
    if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      const path = fileHeaderPath(line.slice(4));
      if (current === undefined) current = open(path);
      else current.path ??= path;
      continue;
    }
    if (line.startsWith("@@")) {
      current ??= open();
      current.lines.push({ kind: "hunk", text: line });
      inHunk = true;
      continue;
    }
    if (!inHunk && DIFF_METADATA_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
    if (line === "" && current === undefined) continue;
    current ??= open();
    current.lines.push({ kind: diffLineKind(line), text: line });
  }

  return files.filter((file) => file.lines.length > 0);
}

function diffLanguage(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : undefined;
}

function renderHTMLDiffLine(line: DiffLine, language: string | undefined): string {
  if (line.kind === "hunk") {
    return `<div class="diff-line diff-hunk">${escapeHTML(line.text)}</div>`;
  }
  const glyph = /^[+\- ]/.test(line.text) ? line.text.slice(0, 1) : "";
  const content = line.text.slice(glyph.length);
  return `<div class="diff-line diff-${line.kind}"><span class="diff-glyph">${escapeHTML(glyph)}</span><span class="diff-code">${highlightInline(content, language)}</span></div>`;
}

function renderHTMLDiff(section: ReportDiffSection): string {
  const files = section.patch.trim() === "" ? [] : parseUnifiedDiff(section.patch);
  if (files.length === 0) return emptyHTML("No diff available.");

  return files
    .map((file) => {
      const language = diffLanguage(file.path);
      const heading =
        file.path === undefined ? "" : `<p class="diff-file">${escapeHTML(file.path)}</p>`;
      const lines = file.lines.map((line) => renderHTMLDiffLine(line, language)).join("");
      return `<div class="diff-file-group">${heading}<div class="report-diff">${lines}</div></div>`;
    })
    .join("");
}

function renderHTMLDiagram(section: ReportDiagramSection): string {
  if (section.mermaid === undefined) {
    return `<pre class="report-code report-diagram-text">${escapeHTML(section.text)}</pre>`;
  }
  return `<div class="report-diagram"><pre class="mermaid">${escapeHTML(section.mermaid)}</pre></div>`;
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
    case "diagram":
      return renderHTMLDiagram(section);
    case "diff":
      return renderHTMLDiff(section);
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

  const visualStyles = carriesVisual(data.sections)
    ? `\n  <style>${highlightStyleBlock(CODE_BLOCK_SELECTOR)}${VISUAL_SECTION_CSS}</style>`
    : "";
  const diagramRuntime = carriesMermaid(data.sections)
    ? `\n  <script id="${MERMAID_RUNTIME_ID}">${readMermaidRuntime()}</script>\n  <script>mermaid.initialize({ startOnLoad: true, securityLevel: "strict" });</script>`
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
  </style>${visualStyles}
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
  </main>${diagramRuntime}
</body>
</html>`;
}

const VISUAL_SECTION_CSS = `
    pre.report-code { background: #f7f9fb; border: 1px solid #e8edf1; border-radius: 10px; margin: 0; overflow-x: auto; padding: 14px 16px; }
    .report-diagram { max-width: 100%; overflow-x: auto; }
    .report-diagram svg { height: auto; max-width: 100%; }
    .report-diagram .mermaid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; margin: 0; white-space: pre; }
    .diff-file-group + .diff-file-group { margin-top: 18px; }
    .diff-file { color: #536273; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; font-weight: 700; margin: 0 0 8px; }
    .report-diff { border: 1px solid #e8edf1; border-radius: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; overflow-x: auto; padding: 6px 0; }
    .diff-line { -webkit-print-color-adjust: exact; min-width: max-content; padding: 0 12px; print-color-adjust: exact; white-space: pre; }
    .diff-glyph { display: inline-block; user-select: none; width: 1ch; }
    .diff-add { background: #e6ffec; }
    .diff-del { background: #ffebe9; }
    .diff-hunk { background: #eef2f6; color: #536273; }
    @media print {
      pre.report-code, .report-diff { border-color: #999; }
      .report-diagram, .report-diff, pre.report-code { overflow: visible; }
      .diff-line { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .diff-hunk { color: #333; }
    }`;

type ReportMetricsSection = Extract<ReportSection, { type: "metrics" }>;

export { escapeHTML };
