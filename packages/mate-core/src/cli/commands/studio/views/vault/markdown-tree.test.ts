import { describe, expect, it } from "bun:test";

import { markdownTree, type MdNode, resolveNoteLink } from "./markdown-tree";

const VOID = new Set(["hr", "br", "input"]);
const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Markup as the browser renders the tree, for readable assertions. */
function serialize(node: MdNode): string {
  if (typeof node === "string") return escape(node);
  const a = node.a ?? {};
  const attributes = [
    a.className ? ` class="${a.className}"` : "",
    a.start !== undefined ? ` start="${a.start}"` : "",
    a.align ? ` style="text-align:${a.align}"` : "",
    a.href ? ` href="${escape(a.href)}" rel="noopener noreferrer"` : "",
    a.note ? ` href="/vault?path=${a.note}" data-vault-entry="${a.note}"` : "",
    node.t === "input" ? ` type="checkbox"${a.checked ? " checked" : ""} disabled` : "",
  ].join("");
  if (VOID.has(node.t)) return `<${node.t}${attributes}>`;
  return `<${node.t}${attributes}>${(node.c ?? []).map(serialize).join("")}</${node.t}>`;
}

const render = (source: string, path = "docs/note.md") =>
  markdownTree(source, path).map(serialize).join("");

describe("markdown tree structures", () => {
  it("renders headings, emphasis, code spans and paragraphs", () => {
    const markup = render("# Title\n\nSome **bold**, *em*, ~~gone~~ and `code`.");
    expect(markup).toContain("<h1>Title</h1>");
    expect(markup).toContain("<strong>bold</strong>");
    expect(markup).toContain("<em>em</em>");
    expect(markup).toContain("<del>gone</del>");
    expect(markup).toContain("<code>code</code>");
    expect(markup).not.toContain("# Title");
  });

  it("renders a table with alignment", () => {
    const markup = render("| a | b |\n|---|:-:|\n| 1 | 2 |");
    expect(markup).toContain("<th>a</th>");
    expect(markup).toContain('<th style="text-align:center">b</th>');
    expect(markup).toContain('<td style="text-align:center">2</td>');
  });

  it("renders nested lists and task lists", () => {
    const markup = render("- [x] done\n  - child\n- [ ] open\n\n1. one\n2. two");
    expect(markup).toContain('<li class="md-task"><input type="checkbox" checked');
    expect(markup).toContain("<ul><li>child</li></ul>");
    expect(markup).toContain("disabled");
    expect(markup).toContain("<ol>");
  });

  it("renders blockquotes", () => {
    expect(render("> quoted")).toContain("<blockquote><p>quoted</p></blockquote>");
  });

  it("highlights a fence for its language and leaves an unknown one plain", () => {
    const known = render("```ts\nconst a = 1;\n```");
    expect(known).toContain('<pre class="md-fence">');
    expect(known).toContain("th-keyword");
    const unknown = render("```nonsense\nconst a = 1;\n```");
    expect(unknown).toContain("const a = 1;");
    expect(unknown).not.toContain("th-keyword");
  });
});

describe("markdown tree safety", () => {
  it("keeps raw html as text, never as an element", () => {
    const tree = JSON.stringify(
      markdownTree('<script>alert(1)</script>\n\ntext <b onclick="x">b</b>', "a.md"),
    );
    expect(tree).not.toContain('"t":"script"');
    expect(tree).not.toContain('"t":"b"');
    expect(render("<script>alert(1)</script>")).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows an unsafe link as text", () => {
    const markup = render("[click](javascript:alert(1)) and [data](data:text/html,x)");
    expect(markup).not.toContain("<a ");
    expect(markup).toContain("click");
    expect(markup).toContain("data");
  });

  it("isolates an external link", () => {
    const markup = render("[site](https://example.com/a)");
    expect(markup).toContain('href="https://example.com/a"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });

  it("shows an image as its alternative text and requests nothing", () => {
    const markup = render("![a diagram](https://example.com/p.png)");
    expect(markup).toContain("a diagram");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("example.com");
  });

  it("shows frontmatter values as text, never as markup", () => {
    expect(render('---\ntitle: "<script>x</script>"\n---\n\nbody')).toContain(
      "<dd>&lt;script&gt;x&lt;/script&gt;</dd>",
    );
  });
});

describe("relative note links", () => {
  it("resolves against the open file's folder", () => {
    expect(resolveNoteLink("../notes/other.md", "docs/sub/note.md")).toBe("docs/notes/other.md");
    expect(resolveNoteLink("./sibling.md", "docs/note.md")).toBe("docs/sibling.md");
    expect(resolveNoteLink("child/x.markdown#part", "note.md")).toBe("child/x.markdown");
  });

  it("opens a markdown file inside the companion", () => {
    const markup = render("[other](../notes/other.md)", "docs/note.md");
    expect(markup).toContain('data-vault-entry="notes/other.md"');
  });

  it("shows a link leaving the companion as text", () => {
    expect(resolveNoteLink("../../outside.md", "docs/note.md")).toBeNull();
    expect(render("[out](../../outside.md)", "docs/note.md")).not.toContain("<a ");
  });

  it("shows a non-markdown target as text", () => {
    expect(resolveNoteLink("data.json", "note.md")).toBeNull();
    expect(render("[d](data.json)")).not.toContain("<a ");
  });

  it("shows an anchor, protocol-relative and absolute path link as text where they cannot open a note", () => {
    expect(resolveNoteLink("#section", "note.md")).toBeNull();
    expect(resolveNoteLink("//evil.test/x.md", "note.md")).toBeNull();
    expect(resolveNoteLink("file:///etc/x.md", "note.md")).toBeNull();
    expect(resolveNoteLink("%2e%2e/%2e%2e/x.md", "a/note.md")).toBeNull();
  });
});

describe("frontmatter", () => {
  it("shows the leading YAML block as fields, lists as chips, before the text", () => {
    const markup = render("---\nname: acme-login\ntags: [auth, web]\nempty:\n---\n# Title\n");
    expect(markup).toStartWith('<div class="md-frontmatter"><dl>');
    expect(markup).toContain("<dt>name</dt><dd>acme-login</dd>");
    expect(markup).toContain(
      '<dt>tags</dt><dd><span class="md-chip">auth</span><span class="md-chip">web</span></dd>',
    );
    expect(markup).toContain('<dt>empty</dt><dd><span class="md-field-empty">empty</span></dd>');
    expect(markup).toContain("<h1>Title</h1>");
    expect(markup).not.toContain("<hr>");
  });

  it("nests a mapping and shows text that is not a mapping as written", () => {
    expect(render("---\nowner:\n  team: acme\n---\n")).toContain(
      "<dt>owner</dt><dd><dl><dt>team</dt><dd>acme</dd></dl></dd>",
    );
    expect(render("---\njust text\n---\nBody")).toContain(
      '<div class="md-frontmatter"><pre class="md-fence"><code>just text</code></pre></div>',
    );
  });

  it("shows a spec delta's mate:delta header as fields, its scopes grouped by repository", () => {
    const markup = render(
      [
        "<!-- mate:delta",
        "change: acme-change",
        "scopes:",
        "  - repository: acme/web",
        "    area: acme",
        "  - repository: acme/web",
        "    area: .",
        "  - repository: acme/api",
        "    area: docs",
        "-->",
        "",
        "## ADDED Requirements",
      ].join("\n"),
    );
    expect(markup).toStartWith(
      '<div class="md-frontmatter"><dl><dt>change</dt><dd>acme-change</dd>',
    );
    expect(markup).toContain(
      '<dt>scopes</dt><dd><div class="md-scope"><span class="md-scope-repo">acme/web</span><span class="md-chip">acme</span><span class="md-chip md-chip-root">root</span></div><div class="md-scope"><span class="md-scope-repo">acme/api</span><span class="md-chip">docs</span></div></dd>',
    );
    // Other small mappings stay one chip each.
    expect(render("---\nowners:\n  - name: acme\n    team: web\n---\n")).toContain(
      '<span class="md-chip">acme · web</span>',
    );
    expect(markup).not.toContain("mate:delta");
    // Any other comment stays visible text.
    expect(render("<!-- note -->\nBody")).toContain("&lt;!-- note --&gt;");
  });

  it("leaves a rule that does not open the file alone", () => {
    expect(render("Intro\n\n---\n\nMore")).toContain("<hr>");
  });
});

describe("OpenSpec requirements and scenarios", () => {
  const spec = [
    "### Requirement: Acme login",
    "The system SHALL sign the user in and MUST NOT keep the password.",
    "",
    "#### Scenario: Valid credentials",
    "- **GIVEN** a registered user",
    "- **WHEN** they sign in",
    "- **THEN** a session starts",
    "- **AND** the password is dropped",
    "",
    "### Requirement: Acme logout",
    "Plain text.",
  ].join("\n");

  it("groups a requirement with its label and marks SHALL and MUST", () => {
    const markup = render(spec);
    expect(markup).toContain(
      '<div class="md-requirement"><h3 class="md-requirement-title"><span class="md-section-label">Requirement</span>Acme login</h3>',
    );
    expect(markup).toContain('<strong class="md-shall">SHALL</strong>');
    expect(markup).toContain('<strong class="md-shall">MUST NOT</strong>');
    expect(markup.match(/class="md-requirement"/g)).toHaveLength(2);
  });

  it("puts each scenario in a card of keyword steps", () => {
    const markup = render(spec);
    expect(markup).toContain(
      '<div class="md-scenario"><p class="md-scenario-title"><span class="md-section-label">Scenario</span>Valid credentials</p><ul class="md-steps">',
    );
    expect(markup).toContain(
      '<li class="md-step"><span class="md-step-key md-key-when">WHEN</span><span>they sign in</span></li>',
    );
    expect(markup).toContain('<span class="md-step-key md-key-and">AND</span>');
    // The scenario closes before the next requirement opens.
    expect(markup.indexOf("md-scenario")).toBeLessThan(markup.indexOf("Acme logout"));
  });

  it("keeps a list whose items are not all steps as a plain list", () => {
    const markup = render("#### Scenario: Mixed\n- **WHEN** a thing\n- a note");
    expect(markup).toContain('<div class="md-scenario">');
    expect(markup).not.toContain("md-steps");
    expect(markup).toContain("<ul><li>");
  });
});
