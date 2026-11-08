import { Lexer, type Token, type Tokens } from "marked";

import { highlightInline } from "./highlight";

/**
 * Safe Markdown subset for report text and captions: paragraphs, headings shifted
 * below the section heading, lists, code spans, strong, emphasis, `http(s)` links,
 * and highlighted code blocks. Tokenized by `marked` and rendered from an allowlist;
 * every other token renders as its escaped source, so raw HTML and unsupported
 * syntax degrade to visible text.
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

const SAFE_URL = /^https?:\/\/\S+$/i;
const CHARACTER_REFERENCE = /&#?\w+;/;

/** Link only a literal http(s) destination as written, never one spelled with references. */
function isSafeLink(token: Tokens.Link): boolean {
  return (
    token.title == null &&
    SAFE_URL.test(token.href) &&
    !CHARACTER_REFERENCE.test(token.href) &&
    token.raw.endsWith(`(${token.href})`)
  );
}

function renderInline(tokens: Token[]): string {
  return tokens.map(renderInlineToken).join("");
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case "text":
      return token.tokens ? renderInline(token.tokens) : escapeHTML(token.text);
    case "escape":
      return escapeHTML(token.text);
    case "strong":
      return `<strong>${renderInline(token.tokens ?? [])}</strong>`;
    case "em":
      return `<em>${renderInline(token.tokens ?? [])}</em>`;
    case "codespan":
      return `<code>${escapeHTML(token.text)}</code>`;
    case "br":
      return "<br>";
    case "link": {
      const link = token as Tokens.Link;
      if (!isSafeLink(link)) return escapeHTML(link.raw);
      return `<a href="${escapeHTML(link.href)}" rel="noopener noreferrer">${renderInline(link.tokens)}</a>`;
    }
    default:
      return escapeHTML(token.raw);
  }
}

function renderBlocks(tokens: Token[]): string {
  return tokens.map(renderBlock).join("");
}

function renderBlock(token: Token): string {
  switch (token.type) {
    case "space":
      return "";
    case "paragraph":
      return `<p>${renderInline(token.tokens ?? [])}</p>`;
    case "text":
      return renderInlineToken(token);
    case "heading": {
      const level = Math.min((token as Tokens.Heading).depth + 2, 6);
      return `<h${level}>${renderInline(token.tokens ?? [])}</h${level}>`;
    }
    case "list": {
      const list = token as Tokens.List;
      const tag = list.ordered ? "ol" : "ul";
      return `<${tag}>${list.items.map((item) => `<li>${renderBlocks(item.tokens)}</li>`).join("")}</${tag}>`;
    }
    case "code": {
      const code = token as Tokens.Code;
      const language = code.lang?.split(/\s/)[0] || undefined;
      return `<pre class="report-code">${highlightInline(code.text, language)}</pre>`;
    }
    default:
      return `<p>${escapeHTML(token.raw.trimEnd())}</p>`;
  }
}

export function renderMarkdownSubset(source: string): string {
  // GFM off: tables, strikethrough, and bare-URL autolinks never tokenize.
  return renderBlocks(new Lexer({ gfm: false }).lex(source));
}
