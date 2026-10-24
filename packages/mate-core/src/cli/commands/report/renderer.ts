import { reportDataToDocument } from "./adapter";
import { validateReportDocument } from "./contract";
import { highlightInline, highlightStyleBlock } from "./highlight";
import { escapeHTML, renderMarkdownSubset } from "./markdown";
import { DARK_PALETTE, LIGHT_PALETTE, paletteCss, type ReportPalette } from "./palette";
import type {
  ReportData,
  ReportDiagramSection,
  ReportDiffSection,
  ReportDocument,
  ReportKeyValue,
  ReportMetric,
  ReportSection,
  ReportStatus,
  ReportStatusTone,
  ReportTextSection,
  ReportValue,
} from "./types";

/**
 * Pinned and integrity-checked, so a CDN cannot serve other code. Offline, the
 * script fails to load and each diagram stays readable as its escaped source.
 */
export const MERMAID_RUNTIME_URL =
  "https://cdn.jsdelivr.net/npm/mermaid@12.0.0/dist/mermaid.min.js";
const MERMAID_RUNTIME_INTEGRITY =
  "sha384-xzghz1GQ5u9HCpVskeDPqMsdogD1yvuMQbEK53+wi+G70+6J1AG0L2cfi9PHjDWI";

const MERMAID_RUNTIME_ID = "mermaid-runtime";

const CODE_BLOCK_SELECTOR = "pre.report-code";

/** A report with more sections than this carries an index linking to each one. */
const INDEX_THRESHOLD = 4;

const carriesMermaid = (sections: ReportSection[]): boolean =>
  sections.some((section) => section.type === "diagram" && section.mermaid !== undefined);

/** Diagrams, diffs, and Markdown text can all carry highlighted code. */
const carriesCode = (sections: ReportSection[]): boolean =>
  sections.some(
    (section) =>
      section.type === "diagram" ||
      section.type === "diff" ||
      (section.type === "text" && section.format === "markdown"),
  );

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

const TONE_WORDS: Record<Exclude<ReportStatusTone, "neutral">, readonly string[]> = {
  ok: [
    "ok",
    "pass",
    "passed",
    "passing",
    "success",
    "succeeded",
    "done",
    "complete",
    "completed",
    "healthy",
    "ready",
    "up",
    "yes",
  ],
  warn: [
    "warn",
    "warning",
    "stale",
    "degraded",
    "pending",
    "partial",
    "skipped",
    "outdated",
    "deprecated",
  ],
  error: [
    "error",
    "fail",
    "failed",
    "failing",
    "failure",
    "missing",
    "broken",
    "down",
    "invalid",
    "blocked",
    "critical",
    "no",
  ],
  info: ["info", "new", "changed", "running", "in progress", "queued", "note"],
};

/** The explicit tone when present, else the tone of a well-known status word, else neutral. */
export function inferTone(item: ReportStatus): ReportStatusTone {
  if (item.tone !== undefined) return item.tone;
  const word = item.status.trim().toLowerCase();
  for (const [tone, words] of Object.entries(TONE_WORDS)) {
    if (words.includes(word)) return tone as ReportStatusTone;
  }
  return "neutral";
}

/** Period, generation time, context, then metadata, as one line of parts. */
function headerParts(data: ReportDocument): string[] {
  return [
    ...(data.period ? [data.period] : []),
    `Generated ${data.generatedAt}`,
    ...(data.context ? [data.context] : []),
    ...data.metadata.map((item) => `${item.label}: ${valueToString(item.value)}`),
  ];
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

function emptyTableMessage(title: string): string {
  const normalized = title.toLowerCase();
  return normalized === "spending" || normalized === "savings"
    ? `No ${normalized} data available.`
    : "No data available.";
}

const withDetail = (value: string, detail: string | undefined): string =>
  detail ? `${value} — ${detail}` : value;

function markdownList(lines: string[]): string {
  return lines.length ? lines.map((line) => `- ${line}`).join("\n") : "No data available.";
}

function markdownKeyValues(items: ReportKeyValue[]): string {
  return markdownList(items.map((item) => `**${item.label}:** ${valueToString(item.value)}`));
}

function markdownMetrics(items: ReportMetric[]): string {
  return markdownList(
    items.map((item) => `**${item.label}:** ${withDetail(valueToString(item.value), item.detail)}`),
  );
}

function withCaption(body: string, caption: string | undefined): string {
  return caption ? `${body}\n\n${caption}` : body;
}

function sectionMarkdown(section: ReportSection): string {
  switch (section.type) {
    case "metadata":
    case "key-value":
      return markdownKeyValues(section.items);
    case "metrics":
      return markdownMetrics(section.items);
    case "table":
      return section.rows.length
        ? renderTable(
            section.columns,
            section.rows.map((row) => row.map(valueToString)),
          )
        : emptyTableMessage(section.title);
    case "statuses":
      return markdownList(
        section.items.map(
          (item) =>
            `[${inferTone(item)}] **${item.label}:** ${withDetail(item.status, item.detail)}`,
        ),
      );
    case "text":
      return section.content;
    case "diagram":
      return withCaption(
        section.mermaid === undefined ? fence("", section.text) : fence("mermaid", section.mermaid),
        section.caption,
      );
    case "diff":
      return withCaption(
        section.patch.trim() ? fence("diff", section.patch) : "No data available.",
        section.caption,
      );
  }
}

function fence(language: string, content: string): string {
  return `\`\`\`${language}\n${content}\n\`\`\``;
}

export function renderMarkdown(input: RenderInput): string {
  const data = normalize(input);
  const parts: string[] = [`# ${data.title}`, headerParts(data).join(" · ")];
  if (data.summary.length) parts.push(`## Summary\n\n${markdownMetrics(data.summary)}`);
  for (const section of data.sections) {
    parts.push(`## ${section.title}\n\n${sectionMarkdown(section)}`);
  }
  return `${parts.join("\n\n")}\n`;
}

export function renderJSON(input: RenderInput): string {
  if (!isReportDocument(input)) return JSON.stringify(input, null, 2);
  return JSON.stringify(normalize(input), null, 2);
}

function emptyHTML(message: string): string {
  return `<p class="empty">${escapeHTML(message)}</p>`;
}

/** Every non-empty cell is a number, or a numeric-looking string such as `$12.50` or `1.2M`. */
const NUMERIC_TEXT = /^[-+]?[$€£]?\d[\d,.]*\s?[KMBT%]?(?:\/[a-z]+)?$/i;
const PLACEHOLDER_TEXT = new Set(["", "N/A", "n/a", "-", "—"]);

function isNumericColumn(rows: ReportValue[][], column: number): boolean {
  const cells = rows
    .map((row) => row[column])
    .filter(
      (cell) => cell !== null && !(typeof cell === "string" && PLACEHOLDER_TEXT.has(cell.trim())),
    );
  if (cells.length === 0) return false;
  return (
    cells.every((cell) => typeof cell === "number") ||
    cells.every((cell) => typeof cell === "string" && NUMERIC_TEXT.test(cell.trim()))
  );
}

function renderHTMLTable(columns: string[], rows: ReportValue[][]): string {
  const numeric = columns.map((_, index) => isNumericColumn(rows, index));
  const numClass = (index: number): string => (numeric[index] ? ' class="num"' : "");
  const headerHTML = columns
    .map((column, index) => `<th scope="col"${numClass(index)}>${escapeHTML(column)}</th>`)
    .join("");
  const rowsHTML = rows
    .map(
      (row) =>
        `<tr>${row.map((value, index) => `<td${numClass(index)}>${escapeHTML(valueToString(value))}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${headerHTML}</tr></thead><tbody>${rowsHTML}</tbody></table></div>`;
}

function renderHTMLKeyValues(items: ReportKeyValue[]): string {
  if (items.length === 0) return emptyHTML("No metadata available.");
  const rows = items
    .map(
      (item) =>
        `<div><dt>${escapeHTML(item.label)}</dt><dd>${escapeHTML(valueToString(item.value))}</dd></div>`,
    )
    .join("");
  return `<dl class="report-kv">${rows}</dl>`;
}

function renderHTMLTiles(items: ReportMetric[]): string {
  const tiles = items
    .map((item) => {
      const detail = item.detail ? `<p class="tile-detail">${escapeHTML(item.detail)}</p>` : "";
      return `<div class="tile"><p class="tile-value">${escapeHTML(valueToString(item.value))}</p><p class="tile-label">${escapeHTML(item.label)}</p>${detail}</div>`;
    })
    .join("");
  return `<div class="report-tiles">${tiles}</div>`;
}

function renderHTMLStatuses(items: ReportStatus[]): string {
  const rows = items
    .map((item) => {
      const detail = item.detail
        ? `<span class="status-detail">${escapeHTML(item.detail)}</span>`
        : "";
      return `<li class="status" data-tone="${inferTone(item)}"><span class="tone-marker" aria-hidden="true"></span><span class="status-label">${escapeHTML(item.label)}</span><span class="status-value">${escapeHTML(item.status)}</span>${detail}</li>`;
    })
    .join("");
  return `<ul class="report-statuses">${rows}</ul>`;
}

function renderHTMLText(section: ReportTextSection): string {
  if (!section.content) return emptyHTML("No text available.");
  return section.format === "markdown"
    ? `<div class="report-text report-markdown">${renderMarkdownSubset(section.content)}</div>`
    : `<p class="report-text">${escapeHTML(section.content).replaceAll("\n", "<br>")}</p>`;
}

function renderHTMLCaption(caption: string | undefined): string {
  return caption
    ? `<div class="report-caption report-markdown">${renderMarkdownSubset(caption)}</div>`
    : "";
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

/** A `classDef`, `style`, or `linkStyle` line that paints with a fixed colour. */
const FIXED_COLOUR_LINE = /^\s*(?:classDef|style|linkStyle)\s.*\b(?:fill|stroke|color)\s*:/;

/**
 * The dark copy drops fixed colours: a light fill authored for a white page would
 * otherwise sit under the dark scheme's light text and hide every label.
 */
function darkMermaidSource(source: string): string {
  return source
    .split("\n")
    .filter((line) => !FIXED_COLOUR_LINE.test(line))
    .join("\n");
}

function renderHTMLDiagram(section: ReportDiagramSection): string {
  if (section.mermaid === undefined) {
    return `<pre class="report-code report-diagram-text">${escapeHTML(section.text)}</pre>`;
  }
  const dark = darkMermaidSource(section.mermaid);
  const darkAttribute = dark === section.mermaid ? "" : ` data-dark-source="${escapeHTML(dark)}"`;
  return `<div class="report-diagram"><pre class="mermaid"${darkAttribute}>${escapeHTML(section.mermaid)}</pre></div>`;
}

function renderHTMLSectionBody(section: ReportSection): string {
  switch (section.type) {
    case "metadata":
    case "key-value":
      return renderHTMLKeyValues(section.items);
    case "metrics":
      return section.items.length
        ? renderHTMLTiles(section.items)
        : emptyHTML("No metrics available.");
    case "table":
      return section.rows.length
        ? renderHTMLTable(section.columns, section.rows)
        : emptyHTML(emptyTableMessage(section.title));
    case "statuses":
      return section.items.length
        ? renderHTMLStatuses(section.items)
        : emptyHTML("No status data available.");
    case "text":
      return renderHTMLText(section);
    case "diagram":
      return renderHTMLDiagram(section) + renderHTMLCaption(section.caption);
    case "diff":
      return renderHTMLDiff(section) + renderHTMLCaption(section.caption);
  }
}

function renderHTMLSection(section: ReportSection): string {
  return `<section id="${escapeHTML(section.id)}"><h2>${escapeHTML(section.title)}</h2>${renderHTMLSectionBody(section)}</section>`;
}

function renderHTMLIndex(sections: ReportSection[]): string {
  if (sections.length <= INDEX_THRESHOLD) return "";
  const links = sections
    .map(
      (section) => `<li><a href="#${escapeHTML(section.id)}">${escapeHTML(section.title)}</a></li>`,
    )
    .join("");
  return `\n    <nav class="report-index interactive-only" aria-label="Sections"><ol>${links}</ol></nav>`;
}

/** The kit's symbol: the Ink bar follows the text colour, the three blocks the accent. */
const MATE_SYMBOL = `<svg class="report-symbol" viewBox="0 0 256 256" width="28" height="28" aria-hidden="true" focusable="false"><path fill="currentColor" d="M36 16H144V240H36A20 20 0 0 1 16 220V36A20 20 0 0 1 36 16Z"/><path class="report-symbol-accent" d="M160 16H220A20 20 0 0 1 240 36V80H160Z M160 96H240V160H160Z M160 176H240V220A20 20 0 0 1 220 240H160Z"/></svg>`;

const PRINT_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/></svg>`;

const PRINT_LABEL = "Print / Save as PDF";

/** Mermaid theme variables for one report palette; notes stay neutral, not mermaid yellow. */
function mermaidThemeVariables(palette: ReportPalette, darkMode: boolean): Record<string, unknown> {
  return {
    darkMode,
    background: palette.bg,
    primaryColor: palette.surface,
    primaryTextColor: palette.ink,
    primaryBorderColor: palette.accent,
    secondaryColor: palette.hunkBg,
    tertiaryColor: palette.bg,
    lineColor: palette.muted,
    textColor: palette.ink,
    noteBkgColor: palette.hunkBg,
    noteBorderColor: palette.rule,
    noteTextColor: palette.ink,
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    fontSize: "14px",
  };
}

const NODE_SHAPES = ["rect", "polygon", "circle", "ellipse", "path"];

/** Node classes an author can apply with `class` or `:::` instead of fixing a colour. */
function mermaidClassCss(palette: ReportPalette): string {
  const classes: [name: string, fill: string, stroke: string][] = [
    ["added", palette.addBg, palette.ok],
    ["changed", palette.hunkBg, palette.info],
    ["removed", palette.delBg, palette.error],
  ];
  return classes
    .map(([name, fill, stroke]) => {
      const selector = NODE_SHAPES.map((shape) => `.node.${name} ${shape}`).join(", ");
      return `${selector} { fill: ${fill} !important; stroke: ${stroke} !important; }`;
    })
    .join(" ");
}

/**
 * Draws every diagram twice, in the light and the dark palette, one diagram at a time.
 * CSS then shows the copy for the active scheme and always the light copy in print, so
 * neither a scheme switch nor printing has to wait for a redraw. A diagram that fails
 * to render keeps showing its escaped source.
 */
const MERMAID_INIT = `(() => {
    const mermaid = window.mermaid;
    if (!mermaid) return;
    const variants = ${JSON.stringify([
      {
        scheme: "light",
        themeVariables: mermaidThemeVariables(LIGHT_PALETTE, false),
        themeCSS: mermaidClassCss(LIGHT_PALETTE),
      },
      {
        scheme: "dark",
        themeVariables: mermaidThemeVariables(DARK_PALETTE, true),
        themeCSS: mermaidClassCss(DARK_PALETTE),
      },
    ])};
    const draw = async (sources, id) => {
      const drawn = [];
      for (const { scheme, themeVariables, themeCSS } of variants) {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables, themeCSS });
        const { svg } = await mermaid.render(id + "-" + scheme, sources[scheme]);
        const figure = document.createElement("div");
        figure.className = "diagram-" + scheme;
        figure.innerHTML = svg;
        drawn.push(figure);
      }
      return drawn;
    };
    (async () => {
      const nodes = [...document.querySelectorAll(".report-diagram pre.mermaid")];
      for (const [index, node] of nodes.entries()) {
        const id = "report-diagram-" + index;
        try {
          const sources = { light: node.textContent, dark: node.dataset.darkSource ?? node.textContent };
          node.after(...(await draw(sources, id)));
          node.hidden = true;
        } catch {
          for (const scheme of ["light", "dark"]) document.getElementById("d" + id + "-" + scheme)?.remove();
        }
      }
    })();
  })();`;

/**
 * Runs before the styles apply: `?scheme=light` or `?scheme=dark` pins the colour scheme
 * through `data-scheme` on `<html>`; any other value leaves the browser preference in charge.
 */
const SCHEME_SCRIPT = `(function () {
    var scheme = new URLSearchParams(location.search).get("scheme");
    if (scheme === "light" || scheme === "dark") document.documentElement.dataset.scheme = scheme;
  })();`;

export function renderHTML(input: RenderInput): string {
  const data = normalize(input);
  const legacy = isReportDocument(input) ? undefined : input;

  const repositoryAttributes = legacy
    ? ` data-working-repository="${escapeHTML(legacy.workingRepoPath)}" data-companion-repository="${escapeHTML(legacy.companionRepoPath)}"`
    : "";

  const meta = headerParts(data)
    .map((part) => `<span>${escapeHTML(part)}</span>`)
    .join("");
  const summary = data.summary.length
    ? `\n    <section id="summary" class="report-summary" aria-label="Summary">${renderHTMLTiles(data.summary)}</section>`
    : "";
  const codeStyles = carriesCode(data.sections)
    ? `\n  <style>${highlightStyleBlock(CODE_BLOCK_SELECTOR)}${VISUAL_SECTION_CSS}</style>`
    : "";
  const diagramRuntime = carriesMermaid(data.sections)
    ? `\n  <script id="${MERMAID_RUNTIME_ID}" src="${MERMAID_RUNTIME_URL}" integrity="${MERMAID_RUNTIME_INTEGRITY}" crossorigin="anonymous"></script>\n  <script>${MERMAID_INIT}</script>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <script id="report-scheme">${SCHEME_SCRIPT}</script>
  <title>${escapeHTML(data.title)}</title>
  <style>
    ${paletteCss()}
    ${REPORT_CSS}
  </style>${codeStyles}
</head>
<body>
  <main class="report" data-report-version="${data.version}"${repositoryAttributes}>
    <header class="report-header">
      <div class="report-heading">
        ${MATE_SYMBOL}
        <h1>${escapeHTML(data.title)}</h1>
        <button class="print-control interactive-only" type="button" aria-label="${PRINT_LABEL}" title="${PRINT_LABEL}" onclick="window.print()">${PRINT_ICON}</button>
      </div>
      <p class="report-meta">${meta}</p>
    </header>${summary}${renderHTMLIndex(data.sections)}
    ${data.sections.map(renderHTMLSection).join("\n    ")}
  </main>${diagramRuntime}
</body>
</html>`;
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const REPORT_CSS = `
    html { background: var(--bg); color: var(--ink); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5; }
    body { margin: 0; }
    a { color: var(--accent); }
    .report { max-width: 1040px; margin: 0 auto; padding: 40px 24px 64px; }
    .report-heading { align-items: center; display: flex; gap: 12px; }
    .report-symbol { color: var(--ink); flex: none; }
    .report-symbol-accent { fill: var(--accent); }
    h1 { flex: 1; font-size: 1.6rem; font-weight: 650; letter-spacing: -.01em; line-height: 1.2; margin: 0; }
    .report-meta { color: var(--muted); font-size: .85rem; margin: 8px 0 0 40px; }
    .report-meta span + span::before { content: "·"; padding: 0 .5em; }
    .print-control { align-items: center; background: transparent; border: 0; border-radius: 8px; color: var(--muted); cursor: pointer; display: inline-flex; flex: none; height: 36px; justify-content: center; padding: 0; width: 36px; }
    .print-control:hover, .print-control:focus-visible { color: var(--accent); }
    .print-control:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    section { margin-top: 40px; }
    h2 { border-bottom: 1px solid var(--rule); color: var(--muted); font-size: .75rem; font-variant: small-caps; font-weight: 650; letter-spacing: .08em; margin: 0 0 16px; padding-bottom: 8px; text-transform: uppercase; }
    .report-tiles { display: grid; gap: 24px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    .tile { border-top: 1px solid var(--rule); padding-top: 12px; }
    .tile p { margin: 0; }
    .tile-value { font-size: 1.6rem; font-variant-numeric: tabular-nums; font-weight: 650; line-height: 1.2; }
    .tile-label { color: var(--muted); font-size: .85rem; margin-top: 4px !important; }
    .tile-detail { color: var(--muted); font-size: .8rem; }
    .report-index ol { display: flex; flex-wrap: wrap; gap: 4px 20px; list-style: none; margin: 32px 0 0; padding: 0; }
    .report-index a { font-size: .85rem; text-decoration: none; }
    .report-index a:hover { text-decoration: underline; }
    .report-kv { display: grid; gap: 8px 24px; grid-template-columns: minmax(140px, max-content) 1fr; margin: 0; }
    .report-kv div { display: contents; }
    .report-kv dt { color: var(--muted); }
    .report-kv dd { margin: 0; overflow-wrap: anywhere; }
    .report-statuses { list-style: none; margin: 0; padding: 0; }
    .status { align-items: baseline; border-bottom: 1px solid var(--rule); display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 8px 0; }
    .status:last-child { border-bottom: 0; }
    .status-label { font-weight: 600; min-width: 140px; }
    .status-value { color: var(--tone); }
    .status-detail { color: var(--muted); flex-basis: 100%; font-size: .85rem; padding-left: 22px; }
    .tone-marker { align-self: center; background: var(--tone); display: inline-block; flex: none; height: 10px; width: 10px; }
    .status[data-tone="ok"] { --tone: var(--ok); }
    .status[data-tone="ok"] .tone-marker { border-radius: 50%; }
    .status[data-tone="neutral"] { --tone: var(--neutral); }
    .status[data-tone="neutral"] .tone-marker { background: transparent; border: 2px solid var(--tone); border-radius: 50%; box-sizing: border-box; }
    .status[data-tone="warn"] { --tone: var(--warn); }
    .status[data-tone="warn"] .tone-marker { clip-path: polygon(50% 0, 100% 100%, 0 100%); }
    .status[data-tone="error"] { --tone: var(--error); }
    .status[data-tone="info"] { --tone: var(--info); }
    .status[data-tone="info"] .tone-marker { transform: rotate(45deg) scale(.85); }
    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; min-width: 100%; }
    th, td { border-bottom: 1px solid var(--rule); padding: 8px 12px; text-align: left; vertical-align: top; }
    th:first-child, td:first-child { padding-left: 0; }
    th:last-child, td:last-child { padding-right: 0; }
    th { color: var(--muted); font-size: .75rem; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
    tbody tr:last-child td { border-bottom: 0; }
    .num { font-variant-numeric: tabular-nums; text-align: right; }
    .report-text { margin: 0; max-width: 72ch; }
    .report-markdown > :first-child { margin-top: 0; }
    .report-markdown > :last-child { margin-bottom: 0; }
    .report-markdown h3, .report-markdown h4, .report-markdown h5, .report-markdown h6 { font-size: 1rem; margin: 20px 0 8px; }
    .report-markdown code { background: var(--surface); border-radius: 4px; font-family: ${MONO}; font-size: .88em; padding: .1em .3em; }
    .report-markdown pre code { background: none; padding: 0; }
    .report-caption { color: var(--muted); font-size: .9rem; margin-top: 12px; max-width: 72ch; }
    .empty { color: var(--muted); margin: 0; }
    @media (max-width: 640px) {
      .report { padding: 24px 16px 40px; }
      .report-meta { margin-left: 0; }
      .report-kv { grid-template-columns: 1fr; gap: 2px; }
      .report-kv dd { margin-bottom: 8px; }
    }
    @media print {
      .report { max-width: none; padding: 0; }
      section { margin-top: 24px; }
      .report-header, h2, .diff-file { break-after: avoid-page; }
      .report-markdown :is(h3, h4, h5, h6) { break-after: avoid-page; }
      .report-markdown :is(ul, ol) { break-inside: avoid-page; }
      .report-caption { break-before: avoid-page; }
      tr, .tile, .status, .report-kv dt, .report-kv dd, .report-markdown li, .report-diagram { break-inside: avoid-page; }
      .report-kv dt { break-after: avoid-page; }
      thead { display: table-header-group; }
      p, li { orphans: 3; widows: 3; }
      .print-control, .interactive-only, .report-index { display: none !important; }
      .table-wrap { overflow: visible; }
      table { width: 100%; }
      .tone-marker { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }`;

const VISUAL_SECTION_CSS = `
    pre.report-code { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; font-family: ${MONO}; font-size: .82rem; margin: 0; overflow-x: auto; padding: 14px 16px; }
    .report-markdown pre.report-code { margin: 12px 0; }
    .report-diagram { max-width: 100%; overflow-x: auto; }
    .report-diagram svg { height: auto; max-width: 100%; }
    .report-diagram svg * { filter: none !important; }
    .report-diagram .diagram-dark { display: none; }
    @media screen and (prefers-color-scheme: dark) {
      :root:not([data-scheme="light"]) .report-diagram .diagram-light { display: none; }
      :root:not([data-scheme="light"]) .report-diagram .diagram-dark { display: block; }
    }
    :root[data-scheme="dark"] .report-diagram .diagram-light { display: none; }
    :root[data-scheme="dark"] .report-diagram .diagram-dark { display: block; }
    .report-diagram .mermaid { font-family: ${MONO}; font-size: .82rem; margin: 0; white-space: pre; }
    .diff-file-group + .diff-file-group { margin-top: 18px; }
    .diff-file { color: var(--muted); font-family: ${MONO}; font-size: .8rem; font-weight: 650; margin: 0 0 8px; }
    .report-diff { border: 1px solid var(--rule); border-radius: 8px; font-family: ${MONO}; font-size: .82rem; overflow-x: auto; padding: 6px 0; }
    .diff-line { -webkit-print-color-adjust: exact; min-width: max-content; padding: 0 12px; print-color-adjust: exact; white-space: pre; }
    .diff-glyph { display: inline-block; user-select: none; width: 1ch; }
    .diff-add { background: var(--add-bg); }
    .diff-del { background: var(--del-bg); }
    .diff-hunk { background: var(--hunk-bg); color: var(--muted); }
    @media print {
      pre.report-code, .report-diff { border-color: #999; }
      .report-diagram { background: #fff; }
      .report-diagram svg { max-height: 90vh; }
      .report-diagram .diagram-light { display: block !important; }
      .report-diagram .diagram-dark { display: none !important; }
      .report-diagram, .report-diff, pre.report-code { overflow: visible; }
      .diff-hunk { color: #333; }
    }`;
