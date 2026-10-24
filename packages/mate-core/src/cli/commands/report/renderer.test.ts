import { describe, expect, test } from "bun:test";
import { BRAND_COLORS } from "../../../brand";
import { DARK_PALETTE, LIGHT_PALETTE } from "./palette";
import { inferTone, renderHTML, renderJSON, renderMarkdown } from "./renderer";
import { REPORT_DOCUMENT_VERSION, type ReportData, type ReportDocument } from "./types";

const makeReport = (overrides: Partial<ReportData> = {}): ReportData => ({
  days: 7,
  generatedAt: "2025-01-15T12:00:00Z",
  workingRepoPath: "/tmp/work",
  companionRepoPath: "/tmp/companion",
  activeAgents: ["claude", "opencode"],
  enabledCapabilities: ["tokensave", "rtk"],
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
    { tool: "rtk", tokensSaved: 1000000, calls: 100, costSaved: 10.0, efficiency: "10K/call" },
  ],
  toolStatus: [
    { name: "ccusage", enabled: true, status: "ok" },
    { name: "tokensave", enabled: true, status: "ok" },
    { name: "rtk", enabled: true, status: "ok" },
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
    expect(md).toContain("rtk");
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
    expect(md).toContain("rtk");
  });

  test("renders tool status table", () => {
    const md = renderMarkdown(makeReport());
    expect(md).toContain("## Tool Status");
    expect(md).toContain("ccusage");
    expect(md).toContain("rtk");
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

describe("renderMarkdown layout", () => {
  test("puts the metadata on one line under the title", () => {
    const md = renderMarkdown(makeReport());

    expect(
      md.startsWith(
        "# Token Usage Report\n\nLast 7 days · Generated 2025-01-15T12:00:00Z · Working repository: /tmp/work",
      ),
    ).toBe(true);
    expect(md).not.toContain("| Field");
  });

  test("lists summary, key-value, and statuses instead of two-column tables", () => {
    const md = renderMarkdown({
      ...mixedDocument,
      summary: [{ label: "Count", value: 3, detail: "since Monday" }],
      sections: [
        {
          id: "pairs",
          title: "Pairs",
          type: "key-value",
          items: [{ label: "Key", value: "Value" }],
        },
        {
          id: "checks",
          title: "Checks",
          type: "statuses",
          items: [
            { label: "Build", status: "Failed", detail: "exit 1" },
            { label: "Docs", status: "ok", tone: "warn" },
          ],
        },
        {
          id: "table",
          title: "Table",
          type: "table",
          columns: ["Name", "Count"],
          rows: [["a", 1]],
        },
      ],
    });

    expect(md).toContain("## Summary\n\n- **Count:** 3 — since Monday");
    expect(md).toContain("## Pairs\n\n- **Key:** Value");
    expect(md).toContain("- [error] **Build:** Failed — exit 1\n- [warn] **Docs:** ok");
    expect(md).toContain("| Name | Count |");
    expect(md).not.toContain("| Metric");
    expect(md).not.toContain("| Status");
  });

  test("emits Markdown text verbatim and captions after fenced visuals", () => {
    const md = renderMarkdown({
      ...mixedDocument,
      sections: [
        {
          id: "notes",
          title: "Notes",
          type: "text",
          format: "markdown",
          content: "- **one**\n- two",
        },
        { id: "flow", title: "Flow", type: "diagram", mermaid: "graph TD", caption: "The *flow*." },
        { id: "patch", title: "Patch", type: "diff", patch: "@@ -1 +1 @@", caption: "One hunk." },
      ],
    });

    expect(md).toContain("## Notes\n\n- **one**\n- two");
    expect(md).toContain("```mermaid\ngraph TD\n```\n\nThe *flow*.");
    expect(md).toContain("```diff\n@@ -1 +1 @@\n```\n\nOne hunk.");
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

describe("renderHTML", () => {
  test("renders structured sections in a self-contained responsive document", () => {
    const html = renderHTML(makeReport());

    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("<style>");
    expect(html).toContain('<section id="summary" class="report-summary"');
    expect(html).toContain('<section id="spending">');
    expect(html).toContain('<section id="savings">');
    expect(html).toContain('<section id="tool-status">');
    expect(html).toContain("claude-sonnet-5");
    expect(html).toContain("tokensave");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("src=");
  });

  test("shows the header as the title with one muted metadata line", () => {
    const html = renderHTML(makeReport());

    expect(html).toContain('<svg class="report-symbol"');
    expect(html).toContain("<h1>Token Usage Report</h1>");
    expect(html).toContain(
      '<p class="report-meta"><span>Last 7 days</span><span>Generated 2025-01-15T12:00:00Z</span><span>Working repository: /tmp/work</span>',
    );
    expect(html).not.toContain('<th scope="col">Field</th>');
  });

  test("renders the summary as tiles rather than a table", () => {
    const html = renderHTML(makeReport());

    expect(html).toContain(
      '<div class="tile"><p class="tile-value">$37.50</p><p class="tile-label">Total spending</p></div>',
    );
    expect(html).not.toContain('<th scope="col">Metric</th>');
  });

  test("drops card styling in favour of rules", () => {
    const html = renderHTML(makeReport());

    expect(html).not.toContain("box-shadow");
    expect(html).not.toContain("border-radius: 14px");
    expect(html).toContain("border-bottom: 1px solid var(--rule)");
  });

  test("right-aligns numeric-looking columns and keeps text columns left", () => {
    const html = renderHTML(makeReport());

    expect(html).toContain('<td>claude-sonnet-5</td><td class="num">100.0K</td>');
    expect(html).toContain('<th scope="col">Model</th><th scope="col" class="num">Input</th>');
    expect(html).toContain('<td class="num">$12.50</td>');
    expect(html).toContain(".num { font-variant-numeric: tabular-nums; text-align: right; }");
  });

  test("shows explicit messages for empty collections", () => {
    const html = renderHTML(makeReport({ spending: [], savings: [] }));

    expect(html).toContain("No spending data available.");
    expect(html).toContain("No savings data available.");
  });

  test("escapes report values in text and attributes", () => {
    const html = renderHTML(
      makeReport({
        workingRepoPath: "/tmp/<work>&\"'",
        companionRepoPath: "/tmp/<companion>",
        enabledCapabilities: ["<capability>"],
        spending: [
          {
            model: "<model>&",
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
            cost: 5,
          },
        ],
        toolStatus: [{ name: "<tool>", enabled: true, status: '"broken"' }],
      }),
    );

    expect(html).toContain("&lt;model&gt;&amp;");
    expect(html).toContain("&lt;capability&gt;");
    expect(html).toContain("&quot;broken&quot;");
    expect(html).toContain('data-working-repository="/tmp/&lt;work&gt;&amp;&quot;&#39;"');
    expect(html).not.toContain("<model>");
  });

  test("renders generic mixed sections, print control, and print styles", () => {
    const html = renderHTML(mixedDocument);

    expect(html).toContain("Mixed &lt;Report&gt;");
    expect(html).toContain("&lt;name&gt;");
    expect(html).toContain(
      '<dl class="report-kv"><div><dt>Tag</dt><dd>&lt;tag&gt;</dd></div></dl>',
    );
    expect(html).toContain('<p class="tile-value">9</p><p class="tile-label">Score</p>');
    expect(html).toContain('<li class="status" data-tone="ok">');
    expect(html).toContain('<p class="report-text">Line one<br>Line two</p>');
    expect(html).toContain("@media print");
    expect(html).toContain(
      ".print-control, .interactive-only, .report-index { display: none !important; }",
    );
    expect(html).toContain("No data available");
  });

  test("renders an icon-only, named print control in the header", () => {
    const html = renderHTML(mixedDocument);
    const button = /<button[^>]*>(.*?)<\/button>/s.exec(html);

    expect(button?.[0]).toContain('aria-label="Print / Save as PDF"');
    expect(button?.[0]).toContain('title="Print / Save as PDF"');
    expect(button?.[0]).toContain('onclick="window.print()"');
    expect(button?.[1]).toMatch(/^<svg [^>]*aria-hidden="true"/);
    expect(button?.[1].replace(/<[^>]+>/g, "")).toBe("");
    expect(html).toContain(".print-control:focus-visible { outline:");
    expect(html.indexOf("<h1>")).toBeLessThan(html.indexOf("<button"));
    expect(html.indexOf("<button")).toBeLessThan(html.indexOf('class="report-meta"'));
  });

  test("carries an index only when there are more than four sections", () => {
    const html = renderHTML(mixedDocument);
    const short = renderHTML({ ...mixedDocument, sections: mixedDocument.sections.slice(0, 4) });

    expect(html).toContain('<nav class="report-index interactive-only" aria-label="Sections">');
    expect(html).toContain('<li><a href="#metadata">Metadata</a></li>');
    expect(html).toContain('<li><a href="#empty">Empty</a></li>');
    expect(short).not.toContain("report-index interactive-only");
  });

  test("lets sections flow across printed pages and keeps small units whole", () => {
    const html = renderHTML(mixedDocument);

    expect(html).not.toContain("section { break-inside: avoid-page");
    expect(html).toContain(".report-header, h2, .diff-file { break-after: avoid-page; }");
    expect(html).toContain(".report-caption { break-before: avoid-page; }");
    expect(html).toContain("tr, .tile, .status,");
    expect(html).toContain("thead { display: table-header-group; }");
  });

  test("follows the colour scheme and prints dark on white", () => {
    const html = renderHTML(mixedDocument);

    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain(
      `@media (prefers-color-scheme: dark) { :root { --ink: ${BRAND_COLORS.cream.hex}; --bg: ${BRAND_COLORS.night.hex};`,
    );
    expect(html).toContain(
      "@media print { :root { color-scheme: light; --ink: #000000; --bg: #FFFFFF;",
    );
  });

  test("renders statuses with explicit or inferred tones", () => {
    const html = renderHTML({
      ...mixedDocument,
      sections: [
        {
          id: "checks",
          title: "Checks",
          type: "statuses",
          items: [
            { label: "Lint", status: "ok", tone: "warn" },
            { label: "Build", status: "Failed", detail: "exit <1>" },
            { label: "Docs", status: "not installed" },
          ],
        },
      ],
    });

    expect(html).toContain(
      '<li class="status" data-tone="warn"><span class="tone-marker" aria-hidden="true"></span><span class="status-label">Lint</span>',
    );
    expect(html).toContain(
      '<li class="status" data-tone="error"><span class="tone-marker" aria-hidden="true"></span><span class="status-label">Build</span><span class="status-value">Failed</span><span class="status-detail">exit &lt;1&gt;</span>',
    );
    expect(html).toContain(
      'data-tone="neutral"><span class="tone-marker" aria-hidden="true"></span><span class="status-label">Docs</span>',
    );
    expect(html).toContain('.status[data-tone="warn"] .tone-marker { clip-path:');
  });

  test("renders text by format", () => {
    const html = renderHTML({
      ...mixedDocument,
      sections: [
        { id: "plain", title: "Plain", type: "text", content: "*not emphasis* <b>" },
        {
          id: "rich",
          title: "Rich",
          type: "text",
          format: "markdown",
          content: "- `one`\n- [two](javascript:alert(1))\n\n```ts\nconst a = 1;\n```",
        },
      ],
    });

    expect(html).toContain('<p class="report-text">*not emphasis* &lt;b&gt;</p>');
    expect(html).toContain(
      '<div class="report-text report-markdown"><ul><li><code>one</code></li>',
    );
    expect(html).not.toContain("href=");
    expect(html).toContain('<span class="th-token th-keyword">const</span>');
    expect(html).toContain("--th-keyword:");
  });
});

const mixedDocument: ReportDocument = {
  version: REPORT_DOCUMENT_VERSION,
  title: "Mixed <Report>",
  generatedAt: "2026-01-01T00:00:00Z",
  metadata: [{ label: "Owner", value: "acme" }],
  summary: [{ label: "Count", value: 3 }],
  sections: [
    {
      id: "metadata",
      title: "Metadata",
      type: "metadata",
      items: [{ label: "Tag", value: "<tag>" }],
    },
    { id: "metrics", title: "Metrics", type: "metrics", items: [{ label: "Score", value: 9 }] },
    {
      id: "pairs",
      title: "Pairs",
      type: "key-value",
      items: [{ label: "Key", value: "Value" }],
    },
    { id: "table", title: "Table", type: "table", columns: ["Name"], rows: [["<name>"]] },
    {
      id: "statuses",
      title: "Statuses",
      type: "statuses",
      items: [{ label: "Build", status: "ok" }],
    },
    { id: "text", title: "Text", type: "text", content: "Line one\nLine two" },
    { id: "empty", title: "Empty", type: "table", columns: ["Value"], rows: [] },
  ],
};

describe("renderHTML numeric columns", () => {
  test("aligns number cells right and leaves mixed columns left", () => {
    const html = renderHTML({
      ...mixedDocument,
      sections: [
        {
          id: "t",
          title: "T",
          type: "table",
          columns: ["Name", "Count", "Mixed"],
          rows: [
            ["a", 1, "12"],
            ["b", null, "n/a value"],
          ],
        },
      ],
    });

    expect(html).toContain(
      '<th scope="col">Name</th><th scope="col" class="num">Count</th><th scope="col">Mixed</th>',
    );
    expect(html).toContain('<td>b</td><td class="num">N/A</td><td>n/a value</td>');
  });
});

const makeDocument = (sections: ReportDocument["sections"]): ReportDocument => ({
  version: REPORT_DOCUMENT_VERSION,
  title: "Visual report",
  generatedAt: "2026-01-01T00:00:00Z",
  metadata: [{ label: "Change", value: "acme-change" }],
  summary: [{ label: "Files", value: 2 }],
  sections,
});

const MULTI_FILE_PATCH = [
  "diff --git a/src/acme.ts b/src/acme.ts",
  "index 1111111..2222222 100644",
  "--- a/src/acme.ts",
  "+++ b/src/acme.ts",
  "@@ -1,3 +1,3 @@",
  ' const label = "<acme>";',
  "-const count = 1;",
  "+const count = 2;",
  "diff --git a/src/acme.css b/src/acme.css",
  "--- a/src/acme.css",
  "+++ b/src/acme.css",
  "@@ -1 +1 @@",
  "-.old { color: red; }",
  "+.new { color: blue; }",
  "",
].join("\n");

const withoutDiagramRuntime = (html: string): string =>
  html.replace(/<script id="mermaid-runtime"[^>]*><\/script>/, "");

describe("renderHTML diagram sections", () => {
  test("loads the pinned diagram runtime and escapes the mermaid payload", () => {
    const html = renderHTML(
      makeDocument([
        {
          id: "structure",
          title: "Structure",
          type: "diagram",
          mermaid: 'classDiagram\n  Renderer --> Highlight : "uses"',
        },
      ]),
    );

    expect(html).toMatch(
      /<script id="mermaid-runtime" src="https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\/dist\/mermaid\.min\.js" integrity="sha384-[A-Za-z0-9+\/=]+" crossorigin="anonymous"><\/script>/,
    );
    expect(html).toContain('securityLevel: "strict"');
    expect(html).toContain("startOnLoad: false");
    expect(html).toContain('theme: "base"');
    expect(html).toContain('"scheme":"light"');
    expect(html).toContain(`"primaryTextColor":"${BRAND_COLORS.cream.hex}"`);
    expect(html).toContain("await mermaid.render(id");
    expect(html).toContain('<div class="report-diagram"><pre class="mermaid">');
    expect(html).toContain("Renderer --&gt; Highlight : &quot;uses&quot;");
    expect(html).not.toContain("Renderer --> Highlight");
  });

  test("drops fixed colours from the dark copy so labels stay readable", () => {
    const source = [
      "flowchart TD",
      "  a[Old] --> b[New]",
      "  classDef fresh fill:#E4F3EA,stroke:#1F5C41",
      "  style a fill:#fff",
      "  linkStyle 0 stroke:#000",
      "  classDef plain stroke-dasharray: 4",
      "  class b fresh",
    ].join("\n");
    const html = renderHTML(
      makeDocument([{ id: "flow", title: "Flow", type: "diagram", mermaid: source }]),
    );

    const dark = [
      "flowchart TD",
      "  a[Old] --&gt; b[New]",
      "  classDef plain stroke-dasharray: 4",
      "  class b fresh",
    ].join("\n");
    expect(html).toContain(`<pre class="mermaid" data-dark-source="${dark}">`);
    expect(html).toContain("node.dataset.darkSource ?? node.textContent");
  });

  test("keeps a single source when the diagram fixes no colour", () => {
    const html = renderHTML(
      makeDocument([
        { id: "flow", title: "Flow", type: "diagram", mermaid: "graph TD\n  A --> B" },
      ]),
    );

    expect(html).not.toContain("data-dark-source");
  });

  test("styles the added, changed, and removed node classes from each palette", () => {
    const html = renderHTML(
      makeDocument([
        { id: "flow", title: "Flow", type: "diagram", mermaid: "graph TD\n  A --> B" },
      ]),
    );

    expect(html).toContain(
      `.node.added rect, .node.added polygon, .node.added circle, .node.added ellipse, .node.added path { fill: ${LIGHT_PALETTE.addBg} !important; stroke: ${LIGHT_PALETTE.ok} !important; }`,
    );
    expect(html).toContain(`.node.removed rect`);
    expect(html).toContain(
      `fill: ${DARK_PALETTE.addBg} !important; stroke: ${DARK_PALETTE.ok} !important;`,
    );
    expect(html).toContain(
      `fill: ${DARK_PALETTE.hunkBg} !important; stroke: ${DARK_PALETTE.info} !important;`,
    );
    expect(html).toContain(
      `fill: ${DARK_PALETTE.delBg} !important; stroke: ${DARK_PALETTE.error} !important;`,
    );
    expect(html).toContain('"themeCSS":');
  });

  test("omits the diagram runtime when no section carries mermaid", () => {
    const html = renderHTML(
      makeDocument([
        { id: "sketch", title: "Sketch", type: "diagram", text: "a -> b" },
        { id: "changes", title: "Changes", type: "diff", patch: MULTI_FILE_PATCH },
      ]),
    );

    expect(html).not.toContain("mermaid-runtime");
    expect(html).not.toContain("initialize(");
  });

  test("preserves line breaks and leading whitespace in a text payload", () => {
    const html = renderHTML(
      makeDocument([
        { id: "sketch", title: "Sketch", type: "diagram", text: "root\n    child <leaf>" },
      ]),
    );

    expect(html).toContain(
      '<pre class="report-code report-diagram-text">root\n    child &lt;leaf&gt;</pre>',
    );
  });

  test("carries no external reference or network-loading attribute", () => {
    const rendered = withoutDiagramRuntime(
      renderHTML(
        makeDocument([
          { id: "structure", title: "Structure", type: "diagram", mermaid: "graph TD\n  A --> B" },
          { id: "changes", title: "Changes", type: "diff", patch: MULTI_FILE_PATCH },
        ]),
      ),
    );

    expect(rendered).not.toContain("://");
    expect(rendered).not.toContain("<link ");
    expect(rendered).not.toContain("@import");
    expect(rendered).not.toContain("@font-face");
    expect(rendered).not.toMatch(/\s(?:src|href)=/);
  });
});

describe("renderHTML captions", () => {
  test("renders a caption beneath the visual without its own heading", () => {
    const html = renderHTML(
      makeDocument([
        {
          id: "flow",
          title: "Flow",
          type: "diagram",
          mermaid: "graph TD\n  A --> B",
          caption: "The **renderer** calls `highlight` <now>.",
        },
        {
          id: "changes",
          title: "Changes",
          type: "diff",
          patch: MULTI_FILE_PATCH,
          caption: "Bumps the count.",
        },
      ]),
    );

    expect(html).toContain(
      '</pre></div><div class="report-caption report-markdown"><p>The <strong>renderer</strong> calls <code>highlight</code> &lt;now&gt;.</p></div></section>',
    );
    expect(html).toContain(
      '<div class="report-caption report-markdown"><p>Bumps the count.</p></div></section>',
    );
    expect(html.match(/<h2>/g)).toHaveLength(2);
  });

  test("gives diagrams a white background in print", () => {
    const html = renderHTML(
      makeDocument([
        { id: "flow", title: "Flow", type: "diagram", mermaid: "graph TD\n  A --> B" },
      ]),
    );

    const print = html.slice(html.lastIndexOf("@media print {"));
    expect(print).toContain(".report-diagram { background: #fff; }");
    expect(print).toContain(".report-diagram .diagram-light { display: block !important; }");
    expect(print).toContain(".report-diagram .diagram-dark { display: none !important; }");
    expect(html).toContain(
      "@media (prefers-color-scheme: dark) {\n      .report-diagram .diagram-light { display: none; }",
    );
  });
});

describe("renderHTML diff sections", () => {
  test("groups a multi-file patch and distinguishes line kinds", () => {
    const html = renderHTML(
      makeDocument([{ id: "changes", title: "Changes", type: "diff", patch: MULTI_FILE_PATCH }]),
    );

    expect(html).toContain('<p class="diff-file">src/acme.ts</p>');
    expect(html).toContain('<p class="diff-file">src/acme.css</p>');
    expect(html).toContain('<div class="diff-line diff-hunk">@@ -1,3 +1,3 @@</div>');
    expect(html).toContain('class="diff-line diff-add"');
    expect(html).toContain('class="diff-line diff-del"');
    expect(html).toContain('class="diff-line diff-context"');
    expect(html).toContain('<span class="diff-glyph">+</span>');
    expect(html).toContain('<span class="diff-glyph">-</span>');
    expect(html).toContain("print-color-adjust: exact");
    expect(html).not.toContain("index 1111111");
  });

  test("escapes markup characters inside diff lines", () => {
    const html = renderHTML(
      makeDocument([{ id: "changes", title: "Changes", type: "diff", patch: MULTI_FILE_PATCH }]),
    );

    expect(html).toContain("&lt;acme&gt;");
    expect(html).not.toContain("<acme>");
  });

  test("shows an explicit no-data message for an empty patch", () => {
    const html = renderHTML(
      makeDocument([{ id: "changes", title: "Changes", type: "diff", patch: "   " }]),
    );

    expect(html).toContain("No diff available.");
    expect(html).not.toContain('class="report-diff"');
  });

  test("renders a patch with no recognizable file header", () => {
    const html = renderHTML(
      makeDocument([
        { id: "changes", title: "Changes", type: "diff", patch: "@@ -1 +1 @@\n-before\n+after" },
      ]),
    );

    expect(html).not.toContain('class="diff-file"');
    expect(html).toContain('<div class="diff-line diff-hunk">@@ -1 +1 @@</div>');
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  test("highlights known languages and falls back to plain text otherwise", () => {
    const html = renderHTML(
      makeDocument([
        {
          id: "changes",
          title: "Changes",
          type: "diff",
          patch: [
            "diff --git a/src/acme.ts b/src/acme.ts",
            "--- a/src/acme.ts",
            "+++ b/src/acme.ts",
            "@@ -1 +1 @@",
            "+const count = 2;",
            "diff --git a/src/acme.rst b/src/acme.rst",
            "--- a/src/acme.rst",
            "+++ b/src/acme.rst",
            "@@ -1 +1 @@",
            "+const count = 2;",
          ].join("\n"),
        },
      ]),
    );

    expect(html).toContain('<span class="th-token th-keyword">const</span>');
    expect(html).toContain('<span class="diff-code">const count = 2;</span>');
  });

  test("carries a highlight style block but no highlighting script, stylesheet, or font", () => {
    const html = renderHTML(
      makeDocument([{ id: "changes", title: "Changes", type: "diff", patch: MULTI_FILE_PATCH }]),
    );

    expect(html).toContain("--th-keyword:");
    expect(html).toContain(".th-keyword { color: var(--th-keyword); }");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link ");
    expect(html).not.toContain("@font-face");
  });
});

describe("visual sections round-trip", () => {
  const visualDocument = makeDocument([
    { id: "structure", title: "Structure", type: "diagram", mermaid: "graph TD\n  A --> B" },
    { id: "sketch", title: "Sketch", type: "diagram", text: "  a -> b" },
    { id: "changes", title: "Changes", type: "diff", patch: MULTI_FILE_PATCH },
  ]);

  test("renderJSON preserves identifiers, types, and payloads", () => {
    expect(JSON.parse(renderJSON(visualDocument)).sections).toEqual(visualDocument.sections);
  });

  test("renderMarkdown fences both payloads verbatim", () => {
    const md = renderMarkdown(visualDocument);

    expect(md).toContain("```mermaid\ngraph TD\n  A --> B\n```");
    expect(md).toContain("```\n  a -> b\n```");
    expect(md).toContain("```diff\ndiff --git a/src/acme.ts b/src/acme.ts");
    expect(md).toContain("## Changes");
  });

  test("renderMarkdown shows a no-data message for an empty patch", () => {
    const md = renderMarkdown(
      makeDocument([{ id: "changes", title: "Changes", type: "diff", patch: "" }]),
    );

    expect(md).toContain("No data available.");
  });
});

describe("inferTone", () => {
  test("an explicit tone wins over the status word", () => {
    expect(inferTone({ label: "Build", status: "ok", tone: "warn" })).toBe("warn");
  });

  test("maps well-known status words case-insensitively", () => {
    expect(inferTone({ label: "A", status: "Failed" })).toBe("error");
    expect(inferTone({ label: "A", status: "Passed" })).toBe("ok");
    expect(inferTone({ label: "A", status: "stale" })).toBe("warn");
    expect(inferTone({ label: "A", status: "missing" })).toBe("error");
    expect(inferTone({ label: "A", status: "  OK  " })).toBe("ok");
    expect(inferTone({ label: "A", status: "In Progress" })).toBe("info");
  });

  test("falls back to neutral for any other text", () => {
    expect(inferTone({ label: "A", status: "not installed" })).toBe("neutral");
    expect(inferTone({ label: "A", status: "ok-ish" })).toBe("neutral");
  });
});
