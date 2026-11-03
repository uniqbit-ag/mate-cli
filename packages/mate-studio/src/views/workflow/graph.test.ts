import { describe, expect, it } from "bun:test";

import { edgeMidpoint, edgePath, workflowGraph, type WorkflowGraph } from "./graph";
import { buildPath, workflowPlan } from "./steps";

const [FULL, MINIMAL] = workflowPlan().paths;

const CUSTOM = workflowPlan({
  topology: {
    schemaName: "acme-v1",
    workflowCapabilityId: "openspec",
    source: "project",
    artifacts: [
      { id: "brief", requires: [] },
      { id: "tasks", requires: ["brief"] },
    ],
    edges: [],
    apply: { requires: ["tasks"] },
  },
}).paths[0];

const UNKNOWN = buildPath("acme-v1", undefined, {});

const slots = (graph: WorkflowGraph) =>
  graph.nodes.map((node) => [node.id, node.column, node.row, node.rowSpan]);

const edges = (graph: WorkflowGraph, kind: "flow" | "bypass") =>
  graph.edges.filter((edge) => edge.kind === kind).map((edge) => `${edge.from}>${edge.to}`);

const sessionEdges = (graph: WorkflowGraph) =>
  graph.edges.filter((edge) => edge.newSession).map((edge) => `${edge.from}>${edge.to}`);

const bands = (graph: WorkflowGraph) =>
  graph.bands.map((band) => [band.phase, band.label, band.from, band.to]);

describe("workflowGraph", () => {
  it("slots the full path: a start marker, single nodes spanning both rows, peers stacked", () => {
    const graph = workflowGraph(FULL);
    expect(graph.columns).toBe(9);
    expect(graph.rows).toBe(2);
    expect(slots(graph)).toEqual([
      ["start", 0, 0, 2],
      ["clarify-intent", 1, 0, 2],
      ["explore", 2, 0, 2],
      ["propose", 3, 0, 2],
      ["reviews", 4, 0, 2],
      ["apply", 5, 0, 2],
      ["inspect-outcome", 6, 0, 1],
      ["refine-code", 6, 1, 1],
      ["archive", 7, 0, 2],
      ["publish", 8, 0, 2],
    ]);
    const reviews = graph.nodes.find((node) => node.kind === "review-group");
    expect(reviews?.kind === "review-group" && reviews.steps.map((step) => step.id)).toEqual([
      "review-proposal",
      "review-specs",
      "review-design",
      "review-tasks",
    ]);
  });

  it("fans out to the optional peers and back in, with one bypass per optional run", () => {
    const graph = workflowGraph(FULL);
    expect(edges(graph, "flow")).toEqual([
      "start>clarify-intent",
      "clarify-intent>explore",
      "explore>propose",
      "propose>reviews",
      "reviews>apply",
      "apply>inspect-outcome",
      "apply>refine-code",
      "inspect-outcome>archive",
      "refine-code>archive",
      "archive>publish",
    ]);
    expect(edges(graph, "bypass")).toEqual(["start>explore", "apply>archive"]);
  });

  it("frames the columns each change repeats, from the start to Archive change", () => {
    expect(workflowGraph(FULL).cycle).toEqual({ from: 0, to: 8 });
    expect(workflowGraph(MINIMAL).cycle).toEqual({ from: 0, to: 8 });
    expect(workflowGraph(UNKNOWN).cycle).toEqual({ from: 0, to: 7 });
  });

  it("marks the edges into each stage that starts a new session", () => {
    expect(sessionEdges(workflowGraph(FULL))).toEqual(["reviews>apply"]);
  });

  it("derives the phase bands as column ranges", () => {
    expect(bands(workflowGraph(FULL))).toEqual([
      ["plan", "Plan", 0, 4],
      ["review", "Review", 4, 5],
      ["build", "Build", 5, 7],
      ["ship", "Ship", 7, 9],
    ]);
  });

  it("groups only the specs and tasks reviews on the minimal path", () => {
    const graph = workflowGraph(MINIMAL);
    const reviews = graph.nodes.find((node) => node.kind === "review-group");
    expect(reviews?.kind === "review-group" && reviews.steps.map((step) => step.id)).toEqual([
      "review-specs",
      "review-tasks",
    ]);
    expect(edges(graph, "bypass")).toEqual(["start>explore", "apply>archive"]);
  });

  it("groups a custom schema's reviews", () => {
    const reviews = workflowGraph(CUSTOM).nodes.find((node) => node.kind === "review-group");
    expect(reviews?.kind === "review-group" && reviews.steps.map((step) => step.id)).toEqual([
      "review-brief",
      "review-tasks",
    ]);
  });

  it("connects Propose to Apply and drops the Review band when reviews are unknown", () => {
    const graph = workflowGraph(UNKNOWN);
    expect(graph.nodes.some((node) => node.kind === "review-group")).toBe(false);
    expect(edges(graph, "flow")).toContain("propose>apply");
    expect(sessionEdges(graph)).toEqual(["propose>apply"]);
    expect(bands(graph).map(([phase]) => phase)).toEqual(["plan", "build", "ship"]);
  });
});

describe("graph geometry", () => {
  const graph = workflowGraph(FULL);
  const edge = (from: string, to: string) =>
    graph.edges.find((candidate) => candidate.from === from && candidate.to === to)!;

  it("curves flow edges between node centers, running top to bottom", () => {
    expect(edgePath(graph, edge("apply", "refine-code"))).toBe("M 2 5.5 C 2 6, 3 6, 3 6.5");
  });

  it("routes a bypass through the lane beside the node rows", () => {
    expect(edgePath(graph, edge("apply", "archive"))).toBe("M 2 5.5 C 5 5.5, 5 7.5, 2 7.5");
  });

  it("puts a session mark at the middle of its edge", () => {
    expect(edgeMidpoint(graph, edge("reviews", "apply"))).toEqual({ along: 5, across: 2 });
  });
});
