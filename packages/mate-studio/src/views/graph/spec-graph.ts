// oxlint-disable-next-line import/no-named-as-default -- the typings export only the default
import Graph from "graphology";
import type { StudioSpecGraph } from "@uniqbit/mate-core/studio";

import {
  type EdgeAttributes,
  type EdgeFilter,
  edgeKey,
  edgeVisible,
  forEachEdge,
  NODE_SIZE,
  type NodeAttributes,
  seedPositions,
} from "./model";

/** The wire graph as graphology; only the canvas chunk imports it. */

export type SpecGraph = Graph<NodeAttributes, EdgeAttributes>;

/** Co-change edges thicken with their weight, capped; mentions stand out from frontmatter edges. */
function edgeSize(kind: EdgeAttributes["kind"], weight: number): number {
  if (kind === "co-change") return Math.min(6, 0.6 + Math.log2(weight + 1));
  if (kind === "mentions") return 1.2;
  return 0.6;
}

/** The wire graph as a mixed multigraph: co-change undirected, the rest directed. */
export function toGraphology(
  wire: StudioSpecGraph,
  positions: readonly { x: number; y: number }[] = seedPositions(wire),
): SpecGraph {
  const graph: SpecGraph = new Graph({ multi: true, type: "mixed", allowSelfLoops: false });
  wire.nodes.forEach((node, index) => {
    graph.addNode(node.id, {
      ...positions[index],
      size: NODE_SIZE[node.kind],
      label: node.label,
      kind: node.kind,
    });
  });
  forEachEdge(wire, (source, target, kind, weight, index) => {
    const attributes: EdgeAttributes = { kind, weight, size: edgeSize(kind, weight) };
    const from = wire.nodes[source].id;
    const to = wire.nodes[target].id;
    if (kind === "co-change") graph.addUndirectedEdgeWithKey(edgeKey(index), from, to, attributes);
    else graph.addDirectedEdgeWithKey(edgeKey(index), from, to, attributes);
  });
  return graph;
}

/** Edges whose visibility differs under `filter`, split into those to hide and to show. */
export function filterEdges(
  graph: SpecGraph,
  filter: EdgeFilter,
): { hide: string[]; show: string[] } {
  const hide: string[] = [];
  const show: string[] = [];
  graph.forEachEdge((edge, attributes) =>
    (edgeVisible(attributes, filter) ? show : hide).push(edge),
  );
  return { hide, show };
}
