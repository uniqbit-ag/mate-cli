interface Options {
  /** The Astro `base`, such as `/mate-cli`. */
  base: string;
}

interface Node {
  type: string;
  url?: string;
  attributes?: { type: string; name?: string; value?: unknown }[];
  children?: Node[];
}

/**
 * Lets authored content link to `/docs/...` (or `/` for the landing page)
 * without knowing the site base. Only those paths are rewritten, so links such
 * as `/api/search` or external URLs stay unchanged.
 */
export function remarkBaseLinks({ base }: Options) {
  const prefix = base.replace(/\/+$/, "");

  function rewrite(url: string): string {
    if (url === "/") return prefix || "/";
    if (url === "/docs" || /^\/docs[/#?]/.test(url)) return `${prefix}${url}`;
    return url;
  }

  function visit(node: Node) {
    if ((node.type === "link" || node.type === "definition") && node.url) {
      node.url = rewrite(node.url);
    }
    if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
      for (const attribute of node.attributes ?? []) {
        if (
          attribute.type === "mdxJsxAttribute" &&
          attribute.name === "href" &&
          typeof attribute.value === "string"
        ) {
          attribute.value = rewrite(attribute.value);
        }
      }
    }
    node.children?.forEach(visit);
  }

  return (tree: Node) => visit(tree);
}
