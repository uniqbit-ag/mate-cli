import { type Token, type Tokens, Lexer } from "marked";
import { parse as parseYaml } from "yaml";

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
  | "dl"
  | "dt"
  | "dd"
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
  /** An allowlisted Studio guide route or fragment. */
  guide?: string;
  id?: string;
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

const SECTION_PREFIX = /^(Requirement|Scenario):\s*/i;
const STEP_KEYWORDS = new Set(["GIVEN", "WHEN", "THEN", "AND", "BUT"]);
const NORMATIVE = /\b(SHALL NOT|SHALL|MUST NOT|MUST)\b/g;

/** OpenSpec's `Requirement:` (level 3) and `Scenario:` (level 4) headings open a section. */
function sectionKind(heading: Tokens.Heading): "requirement" | "scenario" | null {
  const match = SECTION_PREFIX.exec(heading.text);
  if (!match) return null;
  const word = match[1]!.toLowerCase();
  if (word === "requirement" && heading.depth === 3) return "requirement";
  if (word === "scenario" && heading.depth >= 3) return "scenario";
  return null;
}

/** A `- **WHEN** …` item as its keyword and the inline tokens after it. */
function stepOf(item: Tokens.ListItem): { keyword: string; rest: Token[] } | null {
  const first = item.tokens[0];
  if (item.task || first?.type !== "text") return null;
  const inline = (first as Tokens.Text).tokens ?? [];
  const lead = inline[0];
  if (lead?.type !== "strong") return null;
  const keyword = (lead as Tokens.Strong).text.trim().replace(/:$/, "").toUpperCase();
  if (!STEP_KEYWORDS.has(keyword)) return null;
  const rest = inline.slice(1);
  const next = rest[0];
  if (next?.type === "text") {
    const text = next as Tokens.Text;
    const trimmed = text.text.replace(/^[\s:]+/, "");
    rest[0] = { ...text, raw: trimmed, text: trimmed, tokens: undefined };
  }
  return { keyword, rest };
}

const headingTag = (heading: Tokens.Heading): MdTag =>
  `h${Math.min(Math.max(heading.depth, 1), 6)}` as MdTag;

/** SHALL and MUST in a requirement's own paragraphs, so the obligation reads at a glance. */
function markNormative(node: MdNode): MdNode {
  if (typeof node === "string" || node.t !== "p" || !node.c) return node;
  return {
    ...node,
    c: node.c.flatMap((child) =>
      typeof child === "string"
        ? child
            .split(NORMATIVE)
            .filter((part) => part !== "")
            .map((part) =>
              /^(SHALL|MUST)( NOT)?$/.test(part)
                ? el("strong", [part], { className: "md-shall" })
                : part,
            )
        : [child],
    ),
  };
}

/** The same mapping the server-rendered vault used, producing data instead of markup. */
class TreeMapper {
  constructor(
    private readonly path: string,
    private readonly guide?: GuideContext,
  ) {}

  blocks(tokens: Token[] | undefined): MdNode[] {
    const list = tokens ?? [];
    const nodes: MdNode[] = [];
    for (let index = 0; index < list.length; index += 1) {
      const token = list[index]!;
      const kind =
        !this.guide && token.type === "heading" ? sectionKind(token as Tokens.Heading) : null;
      if (!kind) {
        nodes.push(...this.block(token));
        continue;
      }
      // An OpenSpec section runs to the next heading at its own depth or above.
      const heading = token as Tokens.Heading;
      let end = index + 1;
      while (end < list.length) {
        const next = list[end]!;
        if (next.type === "heading" && (next as Tokens.Heading).depth <= heading.depth) break;
        end += 1;
      }
      const body = list.slice(index + 1, end);
      nodes.push(
        kind === "scenario" ? this.scenario(heading, body) : this.requirement(heading, body),
      );
      index = end - 1;
    }
    return nodes;
  }

  /** `### Requirement: …`: the heading with its label, then its text, SHALL marked. */
  private requirement(heading: Tokens.Heading, body: Token[]): MdElement {
    return el(
      "div",
      [
        el(
          headingTag(heading),
          [
            el("span", ["Requirement"], { className: "md-section-label" }),
            ...this.titleOf(heading),
          ],
          { className: "md-requirement-title" },
        ),
        ...this.blocks(body).map(markNormative),
      ],
      { className: "md-requirement" },
    );
  }

  /** `#### Scenario: …` as one card; its `**WHEN**`-style list items become steps. */
  private scenario(heading: Tokens.Heading, body: Token[]): MdElement {
    return el(
      "div",
      [
        el(
          "p",
          [el("span", ["Scenario"], { className: "md-section-label" }), ...this.titleOf(heading)],
          { className: "md-scenario-title" },
        ),
        ...body.flatMap((token) =>
          token.type === "list"
            ? [this.steps(token as Tokens.List) ?? this.list(token as Tokens.List)]
            : this.block(token),
        ),
      ],
      { className: "md-scenario" },
    );
  }

  /** A section heading's text without its `Requirement:` or `Scenario:` prefix. */
  private titleOf(heading: Tokens.Heading): MdNode[] {
    const tokens = heading.tokens ?? [];
    const first = tokens[0];
    if (first?.type !== "text") return this.inline(tokens, heading.text);
    const text = (first as Tokens.Text).text.replace(SECTION_PREFIX, "");
    return [text, ...tokens.slice(1).map((token) => this.span(token))].filter(
      (node) => node !== "",
    );
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
        return [
          el(
            headingTag(heading),
            this.inline(heading.tokens, heading.text),
            this.guide ? { id: this.guide.heading(heading.text) } : undefined,
          ),
        ];
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

  /** A scenario's list as keyword steps, or `null` unless every item is a step. */
  private steps(list: Tokens.List): MdElement | null {
    const steps = list.items.map(stepOf);
    if (!steps.every((step) => step !== null)) return null;
    return el(
      "ul",
      steps.map(({ keyword, rest }) =>
        el(
          "li",
          [
            el("span", [keyword], { className: `md-step-key md-key-${keyword.toLowerCase()}` }),
            el("span", this.inline(rest)),
          ],
          { className: "md-step" },
        ),
      ),
      { className: "md-steps" },
    );
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
    if (this.guide) return el("a", label, { guide: this.guide.link(link.href) });
    const note = resolveNoteLink(link.href, this.path);
    return note === null ? el("span", label) : el("a", label, { note });
  }
}

interface GuideContext {
  heading(text: string): string;
  link(target: string): string;
}

/** Bundled Markdown only; rejects constructs the reader cannot faithfully render. */
export function guideTree(
  source: string,
  path: string,
  routes: Readonly<Record<string, string>>,
): MdNode[] {
  const body = source.replace(FRONTMATTER, "");
  const tokens = new Lexer({ gfm: true }).lex(body);
  const fail = (value: string): never => {
    throw new Error(`${path}: ${value}`);
  };
  const validate = (items: Token[]): void => {
    for (const token of items) {
      if (token.type === "code" || token.type === "codespan" || token.type === "escape") continue;
      if (token.type === "html" || token.type === "image")
        fail(`unsupported ${token.type}: ${token.raw}`);
      if (
        token.type === "text" &&
        !("tokens" in token && token.tokens) &&
        /[{}]|^\s*(?:import|export)\s/m.test(token.raw)
      )
        fail(`unsupported MDX: ${token.raw}`);
      if ("tokens" in token && token.tokens) validate(token.tokens);
      if (token.type === "list")
        for (const item of (token as Tokens.List).items) {
          if (item.task) fail("unsupported task list");
          validate(item.tokens);
        }
      if (token.type === "table") {
        const table = token as Tokens.Table;
        for (const cell of [...table.header, ...table.rows.flat()]) validate(cell.tokens);
      }
    }
  };
  validate(tokens);
  const counts = new Map<string, number>();
  return new TreeMapper(path, {
    heading(text) {
      const slug = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_\s-]/gu, "")
        .replace(/\s/g, "-");
      const count = counts.get(slug) ?? 0;
      counts.set(slug, count + 1);
      return count ? `${slug}-${count}` : slug;
    },
    link(target) {
      if (target.startsWith("#")) return target;
      const [page, fragment] = target.split("#");
      const route = page && Object.hasOwn(routes, page) ? routes[page] : undefined;
      if (!route) return fail(`unresolved or unsafe guide link: ${target}`);
      return `${route}${fragment === undefined ? "" : `#${fragment}`}`;
    },
  }).blocks(tokens);
}

/** A markdown file as data the browser renders; `path` is where its relative links start. */
export function markdownTree(source: string, path: string): MdNode[] {
  const match = FRONTMATTER.exec(source);
  const body = match ? source.slice(match[0].length) : source;
  const nodes = new TreeMapper(path).blocks(new Lexer({ gfm: true }).lex(body));
  return match ? [frontmatter(match[1] ?? match[2] ?? ""), ...nodes] : nodes;
}

/** A text file that is not markdown as one highlighted block; `language` may be an extension. */
export function codeTree(source: string, language: string | undefined): MdNode[] {
  return [el("pre", [el("code", highlighted(source, language))], { className: "md-fence" })];
}

/** `---` YAML, or the `<!-- mate:delta … -->` header Mate writes atop a change's spec delta. */
const FRONTMATTER =
  /^(?:---[ \t]*\r?\n([\s\S]*?)\r?\n---|<!--[ \t]*mate:delta[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*-->)[ \t]*(?:\r?\n|$)/;
/** Nesting shown as fields; deeper values fall back to their JSON text. */
const FIELD_DEPTH = 2;

/** A file's leading YAML block as fields; text that is not a mapping is shown as written. */
function frontmatter(yaml: string): MdElement {
  let data: unknown;
  try {
    data = parseYaml(yaml);
  } catch {
    data = undefined;
  }
  const fields = isRecord(data)
    ? fieldList(data, 0)
    : el("pre", [el("code", [yaml])], { className: "md-fence" });
  return el("div", [fields], { className: "md-frontmatter" });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Only scalar values, so the mapping fits on one chip. */
const flat = (record: Record<string, unknown>): boolean =>
  Object.values(record).every((entry) => entry === null || typeof entry !== "object");

interface Scope {
  repository: string;
  area: string;
}

/** A `scopes` entry: exactly a repository and one of its Areas. */
const isScope = (value: unknown): value is Scope =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  typeof value.repository === "string" &&
  typeof value.area === "string";

/** Scopes grouped by repository, in first-seen order, each Area a chip; `.` is its root. */
function scopeGroups(scopes: Scope[]): MdNode[] {
  const areasByRepository = new Map<string, string[]>();
  for (const { repository, area } of scopes) {
    areasByRepository.set(repository, [...(areasByRepository.get(repository) ?? []), area]);
  }
  return [...areasByRepository].map(([repository, areas]) =>
    el(
      "div",
      [
        el("span", [repository], { className: "md-scope-repo" }),
        ...areas.map((area) =>
          area === "."
            ? el("span", ["root"], { className: "md-chip md-chip-root" })
            : el("span", [area], { className: "md-chip" }),
        ),
      ],
      { className: "md-scope" },
    ),
  );
}

function fieldList(data: Record<string, unknown>, depth: number): MdElement {
  return el(
    "dl",
    Object.entries(data).flatMap(([name, value]) => [
      el("dt", [name]),
      el("dd", fieldValue(value, depth)),
    ]),
  );
}

function fieldValue(value: unknown, depth: number): MdNode[] {
  if (value === null || value === undefined || value === "") {
    return [el("span", ["empty"], { className: "md-field-empty" })];
  }
  if (value instanceof Date) return [value.toISOString().slice(0, 10)];
  if (Array.isArray(value) && value.every((item) => !isRecord(item) && !Array.isArray(item))) {
    return value.map((item) => el("span", [String(item)], { className: "md-chip" }));
  }
  if (Array.isArray(value) && value.length > 0 && value.every(isScope)) return scopeGroups(value);
  // A list of small mappings reads as one chip per item.
  if (Array.isArray(value) && value.every((item) => isRecord(item) && flat(item))) {
    return value.map((item) =>
      el("span", [Object.values(item).map(String).join(" · ")], { className: "md-chip" }),
    );
  }
  if (isRecord(value) && depth < FIELD_DEPTH) return [fieldList(value, depth + 1)];
  if (typeof value === "object") return [el("code", [JSON.stringify(value)])];
  return [String(value)];
}
