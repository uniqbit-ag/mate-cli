import type { StudioSpecGraph } from "@uniqbit/mate-core/studio";

/**
 * The graph as it crosses to the browser. Server functions serialize every array element as
 * its own object, so the large numeric lists travel as strings: about a tenth of the size.
 */
export type PackedSpecGraph = Omit<StudioSpecGraph, "edges" | "history"> & {
  /** `edges` joined by commas. */
  edges: string;
  /** Each node's archive indices joined by commas, nodes joined by semicolons. */
  history: string;
};

export function packGraph(graph: StudioSpecGraph): PackedSpecGraph {
  return {
    ...graph,
    edges: graph.edges.join(","),
    history: graph.history.map((archives) => archives.join(",")).join(";"),
  };
}

const numbers = (text: string): number[] => (text ? text.split(",").map(Number) : []);

export function unpackGraph(packed: PackedSpecGraph): StudioSpecGraph {
  const history = packed.nodes.length === 0 ? [] : packed.history.split(";").map(numbers);
  return { ...packed, edges: numbers(packed.edges), history };
}
