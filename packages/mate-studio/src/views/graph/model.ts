import {
  GRAPH_EDGE_KINDS,
  GRAPH_EDGE_STRIDE,
  type StudioGraphArchive,
  type StudioGraphEdgeKind,
  type StudioGraphNode,
  type StudioGraphNodeKind,
  type StudioSpecGraph,
} from "@uniqbit/mate-core/studio";

/** Pure graph helpers without graphology: seed layout, filters and lookups. */

export interface NodeAttributes {
  x: number;
  y: number;
  size: number;
  label: string;
  kind: StudioGraphNodeKind;
}

export interface EdgeAttributes {
  kind: StudioGraphEdgeKind;
  weight: number;
  size: number;
}

export const NODE_SIZE: Record<StudioGraphNodeKind, number> = {
  repository: 12,
  area: 8,
  capability: 3,
};

/** Edge key of the wire graph's `index`th edge. */
export const edgeKey = (index: number) => `e${index}`;

/** A stable 0..1 value per string, so seeded positions do not move between visits. */
function unit(text: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return ((hash >>> 0) % 100_000) / 100_000;
}

function around(center: { x: number; y: number }, id: string, radius: number) {
  const angle = unit(id, 1) * Math.PI * 2;
  const distance = radius * (0.35 + 0.65 * unit(id, 2));
  return { x: center.x + Math.cos(angle) * distance, y: center.y + Math.sin(angle) * distance };
}

/**
 * Seed positions: repositories on a ring, Areas around their repository, capabilities around
 * their first Area. Layout converges far faster from this than from random positions.
 */
export function seedPositions(wire: StudioSpecGraph): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = wire.nodes.map(() => ({ x: 0, y: 0 }));
  const repositories = wire.nodes.flatMap((node, index) =>
    node.kind === "repository" ? [index] : [],
  );
  const scale = Math.sqrt(wire.nodes.length) * 10;
  repositories.forEach((index, order) => {
    const angle = (order / Math.max(1, repositories.length)) * Math.PI * 2;
    positions[index] =
      repositories.length === 1
        ? { x: 0, y: 0 }
        : { x: Math.cos(angle) * scale, y: Math.sin(angle) * scale };
  });

  const areaOf = new Map<number, number>();
  const repositoryOf = new Map<number, number>();
  forEachEdge(wire, (source, target, kind) => {
    if (kind === "in") repositoryOf.set(source, target);
    if (kind === "binds" && !areaOf.has(source)) areaOf.set(source, target);
  });
  wire.nodes.forEach((node, index) => {
    if (node.kind !== "area") return;
    const repository = repositoryOf.get(index);
    positions[index] = around(
      repository === undefined ? { x: 0, y: 0 } : positions[repository],
      node.id,
      scale / 2,
    );
  });
  wire.nodes.forEach((node, index) => {
    if (node.kind !== "capability") return;
    const area = areaOf.get(index);
    positions[index] =
      area === undefined
        ? around({ x: 0, y: 0 }, node.id, scale * 1.4)
        : around(positions[area], node.id, scale / 5);
  });
  return positions;
}

export function forEachEdge(
  wire: StudioSpecGraph,
  visit: (
    source: number,
    target: number,
    kind: StudioGraphEdgeKind,
    weight: number,
    index: number,
  ) => void,
): void {
  for (
    let offset = 0, index = 0;
    offset < wire.edges.length;
    offset += GRAPH_EDGE_STRIDE, index++
  ) {
    visit(
      wire.edges[offset],
      wire.edges[offset + 1],
      GRAPH_EDGE_KINDS[wire.edges[offset + 2]],
      wire.edges[offset + 3],
      index,
    );
  }
}

export interface EdgeFilter {
  hidden: ReadonlySet<StudioGraphEdgeKind>;
  minWeight: number;
}

export const NO_FILTER: EdgeFilter = { hidden: new Set(), minWeight: 1 };

export function edgeVisible(attributes: EdgeAttributes, filter: EdgeFilter): boolean {
  if (filter.hidden.has(attributes.kind)) return false;
  return attributes.kind !== "co-change" || attributes.weight >= filter.minWeight;
}

/** Layout weight: frontmatter edges pull less, so large Areas do not collapse their specs. */
export function layoutWeight(attributes: EdgeAttributes): number {
  if (attributes.kind === "binds" || attributes.kind === "in") return 0.3;
  if (attributes.kind === "mentions") return 1;
  return Math.min(4, attributes.weight);
}

/** Nodes whose label or pair contains `query`, capabilities first, then by label. */
export function searchNodes(wire: StudioSpecGraph, query: string, limit = 8): StudioGraphNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const rank: Record<StudioGraphNodeKind, number> = { capability: 0, area: 1, repository: 2 };
  return wire.nodes
    .filter((node) =>
      [node.label, node.area, node.repository].some((text) => text?.toLowerCase().includes(needle)),
    )
    .toSorted((a, b) => {
      const exact =
        Number(b.label.toLowerCase() === needle) - Number(a.label.toLowerCase() === needle);
      return exact || rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label);
    })
    .slice(0, limit);
}

export interface NodeIndex {
  byId: Map<string, number>;
  /** Per node, its edges: the other end, kind, edge index, and direction. */
  links: { other: number; kind: StudioGraphEdgeKind; edge: number; outgoing: boolean }[][];
}

export function indexNodes(wire: StudioSpecGraph): NodeIndex {
  const byId = new Map(wire.nodes.map((node, index) => [node.id, index]));
  const links: NodeIndex["links"] = wire.nodes.map(() => []);
  forEachEdge(wire, (source, target, kind, _weight, edge) => {
    links[source].push({ other: target, kind, edge, outgoing: true });
    links[target].push({ other: source, kind, edge, outgoing: false });
  });
  return { byId, links };
}

/** Archives naming both capabilities, newest first: the reasons behind a co-change edge. */
export function sharedArchives(
  wire: StudioSpecGraph,
  left: number,
  right: number,
): StudioGraphArchive[] {
  const other = new Set(wire.history[right]);
  return wire.history[left].flatMap((index) => (other.has(index) ? [wire.archives[index]] : []));
}

export interface EdgeOf {
  source: number;
  target: number;
  kind: StudioGraphEdgeKind;
  weight: number;
}

export function edgeAt(wire: StudioSpecGraph, index: number): EdgeOf | null {
  const offset = index * GRAPH_EDGE_STRIDE;
  if (!Number.isInteger(index) || index < 0 || offset >= wire.edges.length) return null;
  return {
    source: wire.edges[offset],
    target: wire.edges[offset + 1],
    kind: GRAPH_EDGE_KINDS[wire.edges[offset + 2]],
    weight: wire.edges[offset + 3],
  };
}

/** What the Graph panel shows: a node by id, or an edge by its wire index. */
export type GraphSelection = { node: string } | { edge: number };

/** The accessible name of the panel for a selection. */
export function selectionTitle(
  wire: StudioSpecGraph,
  index: NodeIndex,
  selection: GraphSelection,
): string {
  if ("edge" in selection) {
    const found = edgeAt(wire, selection.edge);
    return found
      ? `Connection ${wire.nodes[found.source].label} and ${wire.nodes[found.target].label}`
      : "Connection";
  }
  const node = index.byId.get(selection.node);
  if (node === undefined) return "Graph";
  const entry = wire.nodes[node];
  return `${KIND_TITLES[entry.kind]} ${entry.label}`;
}

const KIND_TITLES: Record<StudioGraphNodeKind, string> = {
  capability: "Spec",
  area: "Area",
  repository: "Repository",
};

/** The panel's id for a selection, as `SidePanel` walks it; `null` when nothing is selected. */
export function selectionId(selection: GraphSelection | null): string | null {
  if (!selection) return null;
  return "edge" in selection ? `edge:${selection.edge}` : selection.node;
}

/** The hint beside a search match: what it is, or for an Area, its repository. */
export function matchHint(node: StudioGraphNode): string {
  if (node.kind === "capability") return "spec";
  if (node.kind === "area") return node.repository ?? "";
  return "repository";
}
