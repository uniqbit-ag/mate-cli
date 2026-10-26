/** @jsxImportSource hono/jsx */

import { type Token, type Tokens, Lexer } from "marked";

import { highlightNodes } from "../../report/highlight";

type Child = unknown;

export interface MarkdownViewProps {
  source: string;
  /** The open file's companion-relative path; relative links resolve against its folder. */
  path: string;
  /** The vault address of a companion-relative markdown path. */
  hrefFor: (path: string) => string;
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

function isWebAddress(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

function Highlighted({ code, language }: { code: string; language: string | undefined }) {
  const render = (node: ReturnType<typeof highlightNodes>[number], key: number): Child =>
    node.type === "text" ? (
      node.value
    ) : (
      <span key={key} className={node.classNames.join(" ")}>
        {node.children.map(render)}
      </span>
    );
  return <>{highlightNodes(code, language).map(render)}</>;
}

/** Plain text of inline tokens, for an image's alternative text. */
function plainText(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens) return fallback;
  return tokens
    .map((token) => ("tokens" in token && token.tokens ? plainText(token.tokens, "") : token.raw))
    .join("");
}

class Mapper {
  constructor(private readonly props: MarkdownViewProps) {}

  blocks(tokens: Token[] | undefined): Child[] {
    return (tokens ?? []).map((token, index) => this.block(token, index));
  }

  inline(tokens: Token[] | undefined, fallback = ""): Child[] {
    if (!tokens) return [fallback];
    return tokens.map((token, index) => this.span(token, index));
  }

  private block(token: Token, key: number): Child {
    switch (token.type) {
      case "space":
      case "def":
        return null;
      case "heading": {
        const heading = token as Tokens.Heading;
        const Tag = `h${Math.min(Math.max(heading.depth, 1), 6)}` as "h1";
        return <Tag key={key}>{this.inline(heading.tokens, heading.text)}</Tag>;
      }
      case "paragraph": {
        const paragraph = token as Tokens.Paragraph;
        return <p key={key}>{this.inline(paragraph.tokens, paragraph.text)}</p>;
      }
      case "text": {
        const text = token as Tokens.Text;
        return <p key={key}>{this.inline(text.tokens, text.text)}</p>;
      }
      case "code": {
        const code = token as Tokens.Code;
        const language = code.lang?.trim().split(/\s+/, 1)[0] || undefined;
        return (
          <pre key={key} className="md-fence">
            <code>
              <Highlighted code={code.text} language={language} />
            </code>
          </pre>
        );
      }
      case "blockquote":
        return (
          <blockquote key={key}>{this.blocks((token as Tokens.Blockquote).tokens)}</blockquote>
        );
      case "hr":
        return <hr key={key} />;
      case "list":
        return this.list(token as Tokens.List, key);
      case "table":
        return this.table(token as Tokens.Table, key);
      case "html":
        // Raw markup is shown as the text it is, never inserted.
        return (
          <p key={key} className="md-raw">
            {(token as Tokens.HTML).raw.trim()}
          </p>
        );
      default:
        return <p key={key}>{token.raw}</p>;
    }
  }

  private list(list: Tokens.List, key: number): Child {
    const Tag = list.ordered ? "ol" : "ul";
    const start =
      list.ordered && typeof list.start === "number" && list.start !== 1 ? list.start : undefined;
    return (
      <Tag key={key} start={start}>
        {list.items.map((item, index) => {
          const body = item.tokens.filter((token) => token.type !== "checkbox");
          return (
            <li key={index} className={item.task ? "md-task" : undefined}>
              {item.task ? (
                <input type="checkbox" checked={!!item.checked} disabled aria-label="Task" />
              ) : null}
              {item.loose ? this.blocks(body) : this.tight(body)}
            </li>
          );
        })}
      </Tag>
    );
  }

  /** A tight item's text sits in the item, not in a paragraph of its own. */
  private tight(tokens: Token[]): Child[] {
    return tokens.map((token, index) =>
      token.type === "text"
        ? this.inline((token as Tokens.Text).tokens, (token as Tokens.Text).text)
        : this.block(token, index),
    );
  }

  private table(table: Tokens.Table, key: number): Child {
    const align = (cell: Tokens.TableCell) => (cell.align ? { textAlign: cell.align } : undefined);
    return (
      <div key={key} className="md-table">
        <table>
          <thead>
            <tr>
              {table.header.map((cell, index) => (
                <th key={index} style={align(cell)}>
                  {this.inline(cell.tokens, cell.text)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, index) => (
                  <td key={index} style={align(cell)}>
                    {this.inline(cell.tokens, cell.text)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  private span(token: Token, key: number): Child {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens ? <span key={key}>{this.inline(text.tokens)}</span> : text.text;
      }
      case "escape":
        return (token as Tokens.Escape).text;
      case "strong":
        return <strong key={key}>{this.inline((token as Tokens.Strong).tokens)}</strong>;
      case "em":
        return <em key={key}>{this.inline((token as Tokens.Em).tokens)}</em>;
      case "del":
        return <del key={key}>{this.inline((token as Tokens.Del).tokens)}</del>;
      case "codespan":
        return <code key={key}>{(token as Tokens.Codespan).text}</code>;
      case "br":
        return <br key={key} />;
      case "link":
        return this.link(token as Tokens.Link, key);
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

  private link(link: Tokens.Link, key: number): Child {
    const label = this.inline(link.tokens, link.text);
    if (isWebAddress(link.href)) {
      return (
        <a key={key} href={link.href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      );
    }
    const note = resolveNoteLink(link.href, this.props.path);
    if (note === null) return <span key={key}>{label}</span>;
    return (
      <a key={key} href={this.props.hrefFor(note)} data-vault-entry={note}>
        {label}
      </a>
    );
  }
}

/** Rendered from lexer tokens to elements, so no part of the file is ever inserted as markup. */
export function MarkdownView(props: MarkdownViewProps) {
  const tokens = new Lexer({ gfm: true }).lex(props.source);
  return <div className="markdown-body">{new Mapper(props).blocks(tokens)}</div>;
}
