import { type Token, type Tokens, Lexer } from "marked";

import { highlightNodes } from "../../../report/highlight";

/**
 * A rendered markdown file as plain data: text, or an element the browser builds from a fixed
 * set of tags and attributes. Parsing, highlighting and link resolution happen on the server,
 * and no part of the file is ever inserted as markup.
 */
export type MdNode = string | MdElement;

export interface MdElement {
  t: MdTag;
  a?: MdAttributes;
  c?: MdNode[];
}

export type MdTag =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "p"
  | "pre"
  | "code"
  | "span"
  | "blockquote"
  | "hr"
  | "ol"
  | "ul"
  | "li"
  | "input"
  | "div"
  | "table"
  | "thead"
  | "tbody"
  | "tr"
  | "th"
  | "td"
  | "strong"
  | "em"
  | "del"
  | "br"
  | "a";

export interface MdAttributes {
  className?: string;
  start?: number;
  checked?: boolean;
  align?: "left" | "right" | "center";
  /** Only an absolute `http`/`https` address; opened without access to the vault page. */
  href?: string;
  /** A companion-relative markdown path the link opens in the vault. */
  note?: string;
}

const MARKDOWN_TARGET = /\.(md|markdown)$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A relative link as a companion-relative markdown path, or `null` when it is anything
 * else. Textual only: nothing is looked up on disk, so a missing note is the vault's to refuse.
 */
export function resolveNoteLink(target: string, openPath: string): string | null {
  if (!target || SCHEME.test(target) || target.startsWith("//") || target.startsWith("#")) {
    return null;
  }
  let pathname = target.split(/[?#]/, 1)[0] ?? "";
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\\") || !MARKDOWN_TARGET.test(pathname)) return null;
  const folder = pathname.startsWith("/") ? [] : openPath.split("/").filter(Boolean).slice(0, -1);
  for (const part of pathname.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (folder.length === 0) return null;
      folder.pop();
    } else {
      folder.push(part);
    }
  }
  return folder.length > 0 ? folder.join("/") : null;
}

const el = (t: MdTag, c?: MdNode[], a?: MdAttributes): MdElement => ({
  t,
  ...(a ? { a } : {}),
  ...(c ? { c } : {}),
});

function plainText(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens) return fallback;
  return tokens
    .map((token) => ("tokens" in token && token.tokens ? plainText(token.tokens, "") : token.raw))
    .join("");
}

function highlighted(code: string, language: string | undefined): MdNode[] {
  const map = (node: ReturnType<typeof highlightNodes>[number]): MdNode =>
    node.type === "text"
      ? node.value
      : el("span", node.children.map(map), { className: node.classNames.join(" ") });
  return highlightNodes(code, language).map(map);
}

/** The same mapping the server-rendered vault used, producing data instead of markup. */
class TreeMapper {
  constructor(private readonly path: string) {}

  blocks(tokens: Token[] | undefined): MdNode[] {
    return (tokens ?? []).flatMap((token) => this.block(token));
  }

  inline(tokens: Token[] | undefined, fallback = ""): MdNode[] {
    if (!tokens) return [fallback];
    return tokens.map((token) => this.span(token));
  }

  private block(token: Token): MdNode[] {
    switch (token.type) {
      case "space":
      case "def":
        return [];
      case "heading": {
        const heading = token as Tokens.Heading;
        const depth = Math.min(Math.max(heading.depth, 1), 6);
        return [el(`h${depth}` as MdTag, this.inline(heading.tokens, heading.text))];
      }
      case "paragraph": {
        const paragraph = token as Tokens.Paragraph;
        return [el("p", this.inline(paragraph.tokens, paragraph.text))];
      }
      case "text": {
        const text = token as Tokens.Text;
        return [el("p", this.inline(text.tokens, text.text))];
      }
      case "code": {
        const code = token as Tokens.Code;
        const language = code.lang?.trim().split(/\s+/, 1)[0] || undefined;
        return [
          el("pre", [el("code", highlighted(code.text, language))], { className: "md-fence" }),
        ];
      }
      case "blockquote":
        return [el("blockquote", this.blocks((token as Tokens.Blockquote).tokens))];
      case "hr":
        return [el("hr")];
      case "list":
        return [this.list(token as Tokens.List)];
      case "table":
        return [this.table(token as Tokens.Table)];
      case "html":
        // Raw markup is shown as the text it is, never inserted.
        return [el("p", [(token as Tokens.HTML).raw.trim()], { className: "md-raw" })];
      default:
        return [el("p", [token.raw])];
    }
  }

  private list(list: Tokens.List): MdElement {
    const start =
      list.ordered && typeof list.start === "number" && list.start !== 1 ? list.start : undefined;
    return el(
      list.ordered ? "ol" : "ul",
      list.items.map((item) => {
        const body = item.tokens.filter((token) => token.type !== "checkbox");
        const content = item.loose ? this.blocks(body) : this.tight(body);
        return el(
          "li",
          item.task ? [el("input", undefined, { checked: !!item.checked }), ...content] : content,
          item.task ? { className: "md-task" } : undefined,
        );
      }),
      start !== undefined ? { start } : undefined,
    );
  }

  /** A tight item's text sits in the item, not in a paragraph of its own. */
  private tight(tokens: Token[]): MdNode[] {
    return tokens.flatMap((token) =>
      token.type === "text"
        ? this.inline((token as Tokens.Text).tokens, (token as Tokens.Text).text)
        : this.block(token),
    );
  }

  private table(table: Tokens.Table): MdElement {
    const cell = (tag: "th" | "td", value: Tokens.TableCell) =>
      el(
        tag,
        this.inline(value.tokens, value.text),
        value.align ? { align: value.align } : undefined,
      );
    return el(
      "div",
      [
        el("table", [
          el("thead", [
            el(
              "tr",
              table.header.map((value) => cell("th", value)),
            ),
          ]),
          el(
            "tbody",
            table.rows.map((row) =>
              el(
                "tr",
                row.map((value) => cell("td", value)),
              ),
            ),
          ),
        ]),
      ],
      { className: "md-table" },
    );
  }

  private span(token: Token): MdNode {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens ? el("span", this.inline(text.tokens)) : text.text;
      }
      case "escape":
        return (token as Tokens.Escape).text;
      case "strong":
        return el("strong", this.inline((token as Tokens.Strong).tokens));
      case "em":
        return el("em", this.inline((token as Tokens.Em).tokens));
      case "del":
        return el("del", this.inline((token as Tokens.Del).tokens));
      case "codespan":
        return el("code", [(token as Tokens.Codespan).text]);
      case "br":
        return el("br");
      case "link":
        return this.link(token as Tokens.Link);
      case "image": {
        // Not requested or shown: only what the author said the image is.
        const image = token as Tokens.Image;
        return image.text || plainText(image.tokens, "");
      }
      case "html":
        return (token as Tokens.HTML).raw;
      default:
        return token.raw;
    }
  }

  private link(link: Tokens.Link): MdNode {
    const label = this.inline(link.tokens, link.text);
    if (/^https?:\/\//i.test(link.href)) return el("a", label, { href: link.href });
    const note = resolveNoteLink(link.href, this.path);
    return note === null ? el("span", label) : el("a", label, { note });
  }
}

/** A markdown file as data the browser renders; `path` is where its relative links start. */
export function markdownTree(source: string, path: string): MdNode[] {
  return new TreeMapper(path).blocks(new Lexer({ gfm: true }).lex(source));
}
