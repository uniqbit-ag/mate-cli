import { describe, expect, test } from "bun:test";

import { renderMarkdownSubset } from "./markdown";

describe("renderMarkdownSubset", () => {
  test("renders paragraphs separated by blank lines", () => {
    expect(renderMarkdownSubset("one\ntwo\n\nthree")).toBe("<p>one\ntwo</p><p>three</p>");
  });

  test("shifts headings below the section heading", () => {
    expect(renderMarkdownSubset("# Top\n### Deep\n###### Deepest")).toBe(
      "<h3>Top</h3><h5>Deep</h5><h6>Deepest</h6>",
    );
  });

  test("renders one-level unordered and ordered lists", () => {
    expect(renderMarkdownSubset("- one\n* two\n\n1. first\n2. second")).toBe(
      "<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>",
    );
  });

  test("renders code spans, strong, and emphasis", () => {
    expect(renderMarkdownSubset("Use `a*b*c` with **care** and *calm* or _ease_.")).toBe(
      "<p>Use <code>a*b*c</code> with <strong>care</strong> and <em>calm</em> or <em>ease</em>.</p>",
    );
  });

  test("leaves snake_case words alone", () => {
    expect(renderMarkdownSubset("read snake_case_name")).toBe("<p>read snake_case_name</p>");
  });

  test("links http and https URLs with a safe rel", () => {
    expect(renderMarkdownSubset("See [docs](https://example.com/a_b_c?x=1&y=2).")).toBe(
      '<p>See <a href="https://example.com/a_b_c?x=1&amp;y=2" rel="noopener noreferrer">docs</a>.</p>',
    );
  });

  test("highlights fenced code by language and keeps unknown fences plain", () => {
    const html = renderMarkdownSubset("```ts\nconst a = 1;\n```\n\n```\n<raw>\n```");

    expect(html).toContain(
      '<pre class="report-code"><span class="th-token th-keyword">const</span>',
    );
    expect(html).toContain('<pre class="report-code">&lt;raw&gt;</pre>');
  });

  test("closes an unterminated fence at the end of the content", () => {
    expect(renderMarkdownSubset("```\nopen")).toBe('<pre class="report-code">open</pre>');
  });

  test("renders a script tag as escaped text", () => {
    const html = renderMarkdownSubset('<script>alert("x")</script>');

    expect(html).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
    expect(html).not.toContain("<script");
  });

  test("renders raw HTML and attributes as escaped text", () => {
    const html = renderMarkdownSubset('<img src=x onerror="alert(1)"> **<b>bold</b>**');

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  test("renders non-http links as plain text", () => {
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,x",
      "/relative",
    ]) {
      const html = renderMarkdownSubset(`[click](${url})`);
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("href=");
      expect(html).toContain("[click](");
    }
  });

  test("does not let an encoded scheme pass as http", () => {
    const html = renderMarkdownSubset("[x](&#106;avascript:alert(1)) [y](https&#58;//x)");

    expect(html).not.toContain("href=");
  });

  test("renders unsupported syntax as literal text", () => {
    expect(renderMarkdownSubset("> quote\n| a | b |")).toBe("<p>&gt; quote\n| a | b |</p>");
  });
});
