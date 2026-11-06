import { describe, expect, test } from "bun:test";

import { guideTree, markdownTree } from "./markdown-tree";

const routes = {
  "/docs/acme": "/getting-started/worktrees",
  "/docs/other": "https://example.com/docs/other/",
};
const tree = (source: string) => guideTree(source, "acme.mdx", routes);

describe("bundled guide Markdown", () => {
  test("strips metadata and emits stable, unique heading anchors", () => {
    expect(tree("---\ntitle: Acme\n---\n## Setup\n\n## Setup")).toEqual([
      { t: "h2", a: { id: "setup" }, c: ["Setup"] },
      { t: "h2", a: { id: "setup-1" }, c: ["Setup"] },
    ]);
  });

  test("maps local topics and fragments, never Vault notes", () => {
    const nodes = JSON.stringify(
      tree("[topic](/docs/acme#setup) [section](#setup) [web](https://example.com)"),
    );
    expect(nodes).toContain('"guide":"/getting-started/worktrees#setup"');
    expect(nodes).toContain('"guide":"#setup"');
    expect(nodes).toContain('"href":"https://example.com"');
    expect(JSON.stringify(tree("[other](/docs/other#intro)"))).toContain(
      '"href":"https://example.com/docs/other/#intro"',
    );
    expect(nodes).not.toContain('"note"');
    expect(JSON.stringify(markdownTree("[note](acme.md)", "index.md"))).toContain(
      '"note":"acme.md"',
    );
  });

  test("keeps fenced code literal and highlighted", () => {
    const nodes = tree("```sh\nmate acme --flag\n```\n\n`<script>{acme}</script>`");
    expect(nodes[0]).toMatchObject({ t: "pre", a: { className: "md-fence" } });
    expect(JSON.stringify(nodes)).toContain("<script>{acme}</script>");
  });

  test("rejects unsafe and unresolved links with the source name", () => {
    for (const target of [
      "javascript:alert",
      "data:text/html,acme",
      "//example.com",
      "/docs/missing",
      "acme.md",
    ]) {
      expect(() => tree(`[acme](${target})`)).toThrow("acme.mdx: unresolved or unsafe guide link");
    }
  });

  test("rejects unsupported MDX, images and raw HTML instead of dropping them", () => {
    for (const source of [
      "<Acme />",
      "export const acme = 1",
      "Hello {acme}",
      "![acme](acme.png)",
      "| Acme |\n| --- |\n| <b>acme</b> |",
      "- <Acme />",
    ]) {
      expect(() => tree(source)).toThrow("acme.mdx: unsupported");
    }
    expect(JSON.stringify(markdownTree("<script>acme</script>", "acme.md"))).toContain(
      "<script>acme</script>",
    );
  });
});
