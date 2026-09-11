import { describe, expect, test } from "bun:test";
import { renderHTML, renderJSON, renderMarkdown } from "./renderer";
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
    expect(html).toContain('<section id="summary">');
    expect(html).toContain('<section id="spending">');
    expect(html).toContain('<section id="savings">');
    expect(html).toContain('<section id="tool-status">');
    expect(html).toContain("claude-sonnet-5");
    expect(html).toContain("tokensave");
    expect(html).not.toContain("https://");
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
    const document: ReportDocument = {
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
    const html = renderHTML(document);

    expect(html).toContain("Mixed &lt;Report&gt;");
    expect(html).toContain("&lt;name&gt;");
    expect(html).toContain("Print / Save as PDF");
    expect(html).toContain("window.print()");
    expect(html).toContain("@media print");
    expect(html).toContain(".print-control, .interactive-only");
    expect(html).toContain("No data available");
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
  html.replace(/<script id="mermaid-runtime">[\s\S]*?<\/script>/, "");

describe("renderHTML diagram sections", () => {
  test("inlines the diagram runtime and escapes the mermaid payload", () => {
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

    expect(html).toContain('<script id="mermaid-runtime">');
    expect(html).toContain('securityLevel: "strict"');
    expect(html).toContain("startOnLoad: true");
    expect(html).toContain('<div class="report-diagram"><pre class="mermaid">');
    expect(html).toContain("Renderer --&gt; Highlight : &quot;uses&quot;");
    expect(html).not.toContain("Renderer --> Highlight");
  });

  test("omits the diagram runtime when no section carries mermaid", () => {
    const html = renderHTML(
      makeDocument([
        { id: "sketch", title: "Sketch", type: "diagram", text: "a -> b" },
        { id: "changes", title: "Changes", type: "diff", patch: MULTI_FILE_PATCH },
      ]),
    );

    expect(html).not.toContain("mermaid-runtime");
    expect(html).not.toContain("mermaid.initialize");
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
