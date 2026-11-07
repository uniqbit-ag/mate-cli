import { guideTree, type MdNode } from "@uniqbit/mate-core/studio";

/** Published docs; linked pages Studio doesn't bundle open there. */
const DOCS_SITE = "https://uniqbit-ag.github.io/mate-cli";

const GUIDE_ROUTES = {
  "/docs/concepts/umbrella-repository": `${DOCS_SITE}/docs/concepts/umbrella-repository/`,
  "/docs/concepts/worktrees": "/getting-started/worktrees",
  "/docs/getting-started/vscode": "/getting-started/vscode",
} as const;

export interface Guide {
  title: string;
  nodes: MdNode[];
}

function visit(nodes: MdNode[], run: (node: Exclude<MdNode, string>) => void): void {
  for (const node of nodes) {
    if (typeof node === "string") continue;
    run(node);
    if (node.c) visit(node.c, run);
  }
}

/** Pure compilation; no filesystem or network access in an installed release. */
export function compileGuides(
  sources: Record<string, { source: string; path: string; title: string }>,
): Record<string, Guide> {
  const result = Object.fromEntries(
    Object.entries(sources).map(([topic, { source, path, title }]) => [
      topic,
      { title, nodes: guideTree(source, path, GUIDE_ROUTES) },
    ]),
  );
  const headingIdsByTopic = new Map<string, Set<string>>();
  for (const [topic, guide] of Object.entries(result)) {
    const headings = new Set<string>();
    visit(guide.nodes, (node) => {
      if (node.a?.id) headings.add(node.a.id);
    });
    headingIdsByTopic.set(topic, headings);
  }
  for (const [topic, guide] of Object.entries(result))
    visit(guide.nodes, (node) => {
      const target = node.a?.guide;
      if (!target) return;
      const [route, fragment] = target.split("#");
      const targetTopic = route ? route.split("/").at(-1)! : topic;
      const targetHeadings = headingIdsByTopic.get(targetTopic);
      if (!targetHeadings || (fragment !== undefined && !targetHeadings.has(fragment))) {
        throw new Error(`${sources[topic]!.path}: unresolved guide target: ${target}`);
      }
    });
  return result;
}
