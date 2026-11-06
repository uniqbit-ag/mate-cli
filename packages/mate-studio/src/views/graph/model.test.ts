import { describe, expect, it } from "bun:test";
import {
  edgeAt,
  edgeKey,
  indexNodes,
  NO_FILTER,
  placeNodes,
  searchNodes,
  seedPositions,
  sharedArchives,
} from "./model";
import { filterEdges, toGraphology } from "./spec-graph";
import { fixture } from "./fixture";

describe("toGraphology", () => {
  it("keeps every node and edge, co-change undirected and the rest directed", () => {
    const graph = toGraphology(fixture());
    expect(graph.order).toBe(5);
    expect(graph.size).toBe(6);
    expect(graph.isUndirected(edgeKey(4))).toBe(true);
    expect(graph.isDirected(edgeKey(3))).toBe(true);
    expect(graph.getEdgeAttribute(edgeKey(4), "weight")).toBe(2);
    expect(graph.getNodeAttribute("repo:acme/web", "size")).toBeGreaterThan(
      graph.getNodeAttribute("spec:acme-auth", "size"),
    );
  });

  it("seeds the same positions on every visit", () => {
    expect(seedPositions(fixture())).toEqual(seedPositions(fixture()));
  });
});

describe("placeNodes", () => {
  it("keeps held positions by node id and places a new node near its held neighbours", () => {
    const wire = fixture();
    const held = new Map(
      wire.nodes.slice(1).map((node, index) => [node.id, { x: index, y: index }]),
    );
    const { positions, missing } = placeNodes(wire, held);
    expect(missing).toBe(1);
    expect(positions.slice(1)).toEqual(
      wire.nodes.slice(1).map((_, index) => ({ x: index, y: index })),
    );
    expect(Math.hypot(positions[0].x, positions[0].y)).toBeLessThan(10);
  });

  it("needs no layout when every node is held", () => {
    const wire = fixture();
    const held = new Map(wire.nodes.map((node) => [node.id, { x: 1, y: 2 }]));
    expect(placeNodes(wire, held).missing).toBe(0);
  });
});

describe("filterEdges", () => {
  it("hides edge kinds and weak co-change edges without touching nodes", () => {
    const graph = toGraphology(fixture());
    const positions = graph.mapNodes((_, attributes) => [attributes.x, attributes.y]);
    expect(filterEdges(graph, NO_FILTER).hide).toEqual([]);
    expect(filterEdges(graph, { hidden: new Set(["binds"]), minWeight: 1 }).hide).toEqual([
      edgeKey(0),
      edgeKey(2),
    ]);
    expect(filterEdges(graph, { hidden: new Set(), minWeight: 2 }).hide).toEqual([edgeKey(5)]);
    expect(graph.mapNodes((_, attributes) => [attributes.x, attributes.y])).toEqual(positions);
  });
});

describe("lookups", () => {
  it("finds nodes by capability, Area path, or repository", () => {
    const wire = fixture();
    expect(searchNodes(wire, "acme-auth")[0].id).toBe("spec:acme-auth");
    expect(searchNodes(wire, "packages/").map((node) => node.id)).toEqual([
      "area:acme/web#packages/acme",
    ]);
    // An exact label wins, then capabilities, Areas and repositories.
    expect(searchNodes(wire, "acme/web").map((node) => node.kind)).toEqual(["repository", "area"]);
    expect(searchNodes(wire, "  ")).toEqual([]);
  });

  it("lists the archives behind a co-change edge, newest first", () => {
    expect(sharedArchives(fixture(), 0, 1).map((archive) => archive.anchor)).toEqual([
      "2026-03-01-new",
      "2026-01-01-old",
    ]);
  });

  it("indexes neighbours and reads single edges", () => {
    const wire = fixture();
    const index = indexNodes(wire);
    expect(index.links[index.byId.get("spec:acme-auth")!].map((link) => link.kind)).toEqual([
      "binds",
      "mentions",
      "co-change",
    ]);
    expect(edgeAt(wire, 4)).toEqual({ source: 0, target: 1, kind: "co-change", weight: 2 });
    expect(edgeAt(wire, 99)).toBeNull();
  });
});
