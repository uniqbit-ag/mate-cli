import { Link } from "@tanstack/react-router";
import type { MdElement, MdNode } from "@uniqbit/mate-core/studio";
import { createElement, type ReactNode } from "react";
import type { StudioSearch } from "../../lib/search";

const TAGS = new Set<string>([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "pre",
  "code",
  "span",
  "blockquote",
  "hr",
  "ol",
  "ul",
  "li",
  "div",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "strong",
  "em",
  "del",
  "br",
]);

function element(node: MdElement, key: number, guideSearch?: StudioSearch): ReactNode {
  const children = node.c?.map((child, index) => render(child, index, guideSearch));
  const { a } = node;
  if (node.t === "a") {
    if (guideSearch && a?.guide) {
      const [path, hash] = a.guide.split("#");
      if (path && !/^\/getting-started(?:\/(?:worktrees|vscode))?$/.test(path)) {
        return <span key={key}>{children}</span>;
      }
      return (
        <Link key={key} to={path || "."} hash={hash} search={guideSearch}>
          {children}
        </Link>
      );
    }
    if (a?.note) {
      return (
        <Link
          key={key}
          to="/vault"
          search={(previous) => ({ ...previous, path: a.note, dir: undefined, mode: undefined })}
          data-vault-entry={a.note}
        >
          {children}
        </Link>
      );
    }
    // Only an absolute web address reaches here; it opens without access to the vault page.
    if (a?.href && /^https?:\/\//i.test(a.href)) {
      return (
        <a key={key} href={a.href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    }
    return <span key={key}>{children}</span>;
  }
  if (node.t === "input") {
    return (
      <input key={key} type="checkbox" checked={!!a?.checked} disabled readOnly aria-label="Task" />
    );
  }
  // A tag outside the fixed set is shown as its text, never created.
  if (!TAGS.has(node.t)) return <span key={key}>{children}</span>;
  if (guideSearch && a?.id && children)
    children.push(
      <Link
        key="anchor"
        to="."
        hash={a.id}
        search={guideSearch}
        className="guide-anchor"
        aria-label={`Link to ${a.id}`}
      >
        #
      </Link>,
    );
  return createElement(
    node.t,
    {
      key,
      className: a?.className,
      id: guideSearch ? a?.id : undefined,
      tabIndex: guideSearch && a?.id ? -1 : undefined,
      start: a?.start,
      style: a?.align ? { textAlign: a.align } : undefined,
    },
    children && children.length > 0 ? children : undefined,
  );
}

function render(node: MdNode, key: number, guideSearch?: StudioSearch): ReactNode {
  return typeof node === "string" ? node : element(node, key, guideSearch);
}

/** A file the server rendered to data; React escapes every value it shows. */
export function MarkdownView({
  nodes,
  guideSearch,
}: {
  nodes: MdNode[];
  guideSearch?: StudioSearch;
}) {
  return (
    <div className="markdown-body">
      {nodes.map((node, index) => render(node, index, guideSearch))}
    </div>
  );
}
