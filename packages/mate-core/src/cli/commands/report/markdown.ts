import { highlightInline } from "./highlight";

/**
 * Safe Markdown subset for report text and captions: paragraphs, headings shifted
 * below the section heading, one-level lists, code spans, strong, emphasis,
 * `http(s)` links, and highlighted fenced code. Every literal is escaped before
 * markup is added, so raw HTML and any other syntax degrade to visible text.
 */

export function escapeHTML(value: string): string {
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

const FENCE = /^\s{0,3}```\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^\s{0,3}([-*]|\d+[.)])\s+(.*)$/;
const INLINE_TOKEN = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^()\s]+)\)/g;
const SAFE_URL = /^https?:\/\/\S+$/i;

/** Emphasis runs over already-escaped text, which carries no `*` or `_` of its own. */
function emphasize(escaped: string): string {
  return escaped
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(?=\S)([^*]*?\S)\*/g, "<em>$1</em>")
    .replace(/(^|\W)_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>");
}

function renderInline(source: string): string {
  let html = "";
  let last = 0;
  for (const match of source.matchAll(INLINE_TOKEN)) {
    html += emphasize(escapeHTML(source.slice(last, match.index)));
    const [whole, code, label, url] = match;
    if (code !== undefined) {
      html += `<code>${escapeHTML(code)}</code>`;
    } else if (SAFE_URL.test(url)) {
      html += `<a href="${escapeHTML(url)}" rel="noopener noreferrer">${emphasize(escapeHTML(label))}</a>`;
    } else {
      html += emphasize(escapeHTML(whole));
    }
    last = match.index + whole.length;
  }
  return html + emphasize(escapeHTML(source.slice(last)));
}

function renderFence(code: string[], language: string): string {
  return `<pre class="report-code">${highlightInline(code.join("\n"), language || undefined)}</pre>`;
}

export function renderMarkdownSubset(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;

  const flush = (): void => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map(renderInline).join("\n")}</p>`);
    if (list) blocks.push(`<${list.tag}>${list.items.join("")}</${list.tag}>`);
    paragraph = [];
    list = undefined;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      while (++index < lines.length && !FENCE.test(lines[index])) code.push(lines[index]);
      blocks.push(renderFence(code, fence[1]));
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 2, 6);
      blocks.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const tag = /\d/.test(item[1]) ? "ol" : "ul";
      if (paragraph.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(`<li>${renderInline(item[2])}</li>`);
      continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  return blocks.join("");
}
