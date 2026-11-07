import { describe, expect, it } from "bun:test";

import { fixture } from "../views/graph/fixture";
import { packGraph, unpackGraph } from "./graph-wire";

describe("graph wire packing", () => {
  it("round-trips a graph, empty histories included", () => {
    const graph = fixture();
    expect(unpackGraph(packGraph(graph))).toEqual(graph);
  });

  it("round-trips names with separators and quotes", () => {
    const graph = fixture();
    graph.nodes[0] = { kind: "capability", id: 'spec:acme,"odd";\tone', label: 'acme,"odd";\tone' };
    graph.archives[0] = { ...graph.archives[0], name: 'a "b", c' };
    expect(unpackGraph(packGraph(graph))).toEqual(graph);
  });

  it("round-trips an empty graph", () => {
    const empty = { nodes: [], edges: [], archives: [], history: [], unbound: [], broken: [] };
    expect(unpackGraph(packGraph(empty))).toEqual(empty);
  });

  it("carries the numeric lists as strings", () => {
    const packed = packGraph(fixture());
    expect(typeof packed.edges).toBe("string");
    expect(typeof packed.nodes).toBe("string");
    expect(typeof packed.archives).toBe("string");
    expect(packed.history).toBe("0,2;0,1,2;1;;");
  });
});
