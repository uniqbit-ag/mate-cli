import { Link } from "@tanstack/react-router";
import type { MdElement, MdNode } from "@uniqbit/mate-core/studio";
import { createElement, type ReactNode } from "react";

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

function element(node: MdElement, key: number): ReactNode {
  const children = node.c?.map(render);
  const { a } = node;
  if (node.t === "a") {
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
  return createElement(
    node.t,
    {
      key,
      className: a?.className,
      start: a?.start,
      style: a?.align ? { textAlign: a.align } : undefined,
    },
    children && children.length > 0 ? children : undefined,
  );
}

function render(node: MdNode, key: number): ReactNode {
  return typeof node === "string" ? node : element(node, key);
}

/** A file the server rendered to data; React escapes every value it shows. */
export function MarkdownView({ nodes }: { nodes: MdNode[] }) {
  return <div className="markdown-body">{nodes.map(render)}</div>;
}
