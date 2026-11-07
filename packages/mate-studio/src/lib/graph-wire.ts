import type {
  StudioGraphArchive,
  StudioGraphNode,
  StudioSpecGraph,
} from "@uniqbit/mate-core/studio";

/**
 * The graph as it crosses to the browser. Server functions serialize every array element and
 * object as its own record, so the large lists travel as single strings: numbers joined by
 * separators, nodes and archives as JSON columns. At 100k nodes that is about a fifth of the size.
 */
export interface PackedSpecGraph {
  /** JSON of `[kinds, ids, labels, repositories, areas]`; absent fields are empty strings. */
  nodes: string;
  /** `edges` joined by commas. */
  edges: string;
  /** JSON of `[anchors, names, dates, artifacts]`, artifacts joined by commas. */
  archives: string;
  /** Each node's archive indices joined by commas, nodes joined by semicolons. */
  history: string;
  /** Node count, so an empty history string still decodes to the right length. */
  order: number;
  unbound: string[];
  broken: StudioSpecGraph["broken"];
}

export function packGraph(graph: StudioSpecGraph): PackedSpecGraph {
  const { nodes, archives } = graph;
  return {
    nodes: JSON.stringify([
      nodes.map((node) => node.kind),
      nodes.map((node) => node.id),
      nodes.map((node) => node.label),
      nodes.map((node) => node.repository ?? ""),
      nodes.map((node) => node.area ?? ""),
    ]),
    edges: graph.edges.join(","),
    archives: JSON.stringify([
      archives.map((archive) => archive.anchor),
      archives.map((archive) => archive.name),
      archives.map((archive) => archive.archivedOn),
      archives.map((archive) => archive.artifacts.join(",")),
    ]),
    history: graph.history.map((indices) => indices.join(",")).join(";"),
    order: nodes.length,
    unbound: graph.unbound,
    broken: graph.broken,
  };
}

/** `count` equally long string columns from packed JSON; anything else is a broken answer. */
function columns(text: string, count: number, what: string): string[][] {
  const parsed: unknown = JSON.parse(text);
  const valid =
    Array.isArray(parsed) &&
    parsed.length === count &&
    parsed.every(
      (column) =>
        Array.isArray(column) &&
        column.length === parsed[0].length &&
        column.every((cell) => typeof cell === "string"),
    );
  if (!valid) throw new Error(`the graph's ${what} could not be read`);
  return parsed as string[][];
}

const numbers = (text: string): number[] => (text ? text.split(",").map(Number) : []);

export function unpackGraph(packed: PackedSpecGraph): StudioSpecGraph {
  const [kinds, ids, labels, repositories, areas] = columns(packed.nodes, 5, "nodes");
  const nodes: StudioGraphNode[] = ids.map((id, index) => ({
    kind: kinds[index] as StudioGraphNode["kind"],
    id,
    label: labels[index],
    // Only Area nodes carry their pair.
    ...(repositories[index] ? { repository: repositories[index] } : {}),
    ...(areas[index] ? { area: areas[index] } : {}),
  }));
  const [anchors, names, dates, artifacts] = columns(packed.archives, 4, "archives");
  const archives: StudioGraphArchive[] = anchors.map((anchor, index) => ({
    anchor,
    name: names[index],
    archivedOn: dates[index],
    artifacts: artifacts[index] ? artifacts[index].split(",") : [],
  }));
  const history = packed.order === 0 ? [] : packed.history.split(";").map(numbers);
  return {
    nodes,
    edges: numbers(packed.edges),
    archives,
    history,
    unbound: packed.unbound,
    broken: packed.broken,
  };
}
