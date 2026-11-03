import { PHASE_LABELS, type WorkflowPath, type WorkflowPhaseId, type WorkflowStep } from "./steps";

/** Slot on the graph grid: a column per sequential position, a row per stacked peer. */
interface GraphSlot {
  column: number;
  row: number;
  rowSpan: number;
}

type ColumnNode =
  | { id: "start"; kind: "start" }
  | { id: string; kind: "stage"; step: WorkflowStep }
  | { id: "reviews"; kind: "review-group"; steps: WorkflowStep[] };

export type WorkflowGraphNode = GraphSlot & ColumnNode;

export interface WorkflowGraphEdge {
  from: string;
  to: string;
  /** A bypass skips an optional stage or run of optional peers. */
  kind: "flow" | "bypass";
  /** The stage the edge enters starts a new session. */
  newSession: boolean;
}

/** A phase as a column range, `to` exclusive. */
export interface WorkflowGraphBand {
  phase: WorkflowPhaseId;
  label: string;
  from: number;
  to: number;
}

export interface WorkflowGraph {
  columns: number;
  /** Node rows; the bypass lane below them is not counted. */
  rows: number;
  /** Stage order: columns left to right, peers top to bottom. */
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  bands: WorkflowGraphBand[];
  /** Columns each change of a feature repeats, from the start to Archive change; `to` exclusive. */
  cycle: { from: number; to: number } | null;
}

interface Column {
  nodes: ColumnNode[];
  optional: boolean;
  phase: WorkflowPhaseId;
}

const stageNode = (step: WorkflowStep): ColumnNode => ({ id: step.id, kind: "stage", step });

function columnsOf(path: WorkflowPath): Column[] {
  const columns: Column[] = path.map.map((entry) => {
    if (entry.kind === "stage") {
      return {
        nodes: [stageNode(entry.step)],
        optional: entry.step.optional,
        phase: entry.step.phase,
      };
    }
    if (entry.group === "human") {
      return {
        nodes: [{ id: "reviews", kind: "review-group", steps: entry.steps }],
        optional: false,
        phase: entry.steps[0].phase,
      };
    }
    return { nodes: entry.steps.map(stageNode), optional: true, phase: entry.steps[0].phase };
  });
  // The start marker anchors the bypass of a leading optional run and opens the cycle.
  columns.unshift({
    nodes: [{ id: "start", kind: "start" }],
    optional: false,
    phase: columns[0]?.phase ?? "plan",
  });
  return columns;
}

function entersNewSession(node: ColumnNode): boolean {
  if (node.kind === "stage") return Boolean(node.step.sessionBreakBefore);
  if (node.kind === "review-group") return Boolean(node.steps[0].sessionBreakBefore);
  return false;
}

function edgesOf(columns: readonly Column[]): WorkflowGraphEdge[] {
  const edges: WorkflowGraphEdge[] = [];
  const link = (
    from: readonly ColumnNode[],
    to: readonly ColumnNode[],
    kind: "flow" | "bypass",
  ) => {
    for (const a of from) {
      for (const b of to)
        edges.push({ from: a.id, to: b.id, kind, newSession: entersNewSession(b) });
    }
  };
  columns.forEach((column, index) => {
    const next = columns[index + 1];
    if (next) link(column.nodes, next.nodes, "flow");
    const before = columns[index - 1];
    if (column.optional && before && next) link(before.nodes, next.nodes, "bypass");
  });
  return edges;
}

function bandsOf(columns: readonly Column[]): WorkflowGraphBand[] {
  const bands: WorkflowGraphBand[] = [];
  columns.forEach((column, index) => {
    const band = bands.at(-1);
    if (band?.phase === column.phase) {
      band.to = index + 1;
      return;
    }
    bands.push({
      phase: column.phase,
      label: PHASE_LABELS[column.phase],
      from: index,
      to: index + 1,
    });
  });
  return bands;
}

/** Changes archive before they publish, so everything up to Archive change repeats per change. */
function cycleOf(columns: readonly Column[]): WorkflowGraph["cycle"] {
  const archive = columns.findIndex((column) => column.nodes.some((node) => node.id === "archive"));
  return archive === -1 ? null : { from: 0, to: archive + 1 };
}

/** The path's node graph. Single nodes span every row; peers take a row each. */
export function workflowGraph(path: WorkflowPath): WorkflowGraph {
  const columns = columnsOf(path);
  const rows = Math.max(1, ...columns.map((column) => column.nodes.length));
  const nodes = columns.flatMap((column, index) =>
    column.nodes.map((node, row): WorkflowGraphNode =>
      column.nodes.length === 1
        ? { ...node, column: index, row: 0, rowSpan: rows }
        : { ...node, column: index, row, rowSpan: 1 },
    ),
  );
  return {
    columns: columns.length,
    rows,
    nodes,
    edges: edgesOf(columns),
    bands: bandsOf(columns),
    cycle: cycleOf(columns),
  };
}

/**
 * Drawing units, top to bottom: one per column down the flow; two per node row across it,
 * plus one for the bypass lane on the right. Node rows are laid out at `2fr` and the lane
 * at `1fr` to match.
 */
export interface GraphPoint {
  along: number;
  across: number;
}

export const graphAcross = (graph: WorkflowGraph): number => graph.rows * 2 + 1;

export function nodeCenter(node: WorkflowGraphNode): GraphPoint {
  return { along: node.column + 0.5, across: node.row * 2 + node.rowSpan };
}

const round = (value: number): number => Math.round(value * 1e4) / 1e4;

const percent = (part: number, whole: number): string => `${round((part / whole) * 100)}%`;

/** An SVG `x y` pair: across is horizontal, along runs down. */
const pair = ({ along, across }: GraphPoint): string => `${round(across)} ${round(along)}`;

function endpoints(graph: WorkflowGraph, edge: WorkflowGraphEdge): [GraphPoint, GraphPoint] {
  const at = (id: string): GraphPoint => {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`Unknown graph node: ${id}`);
    return nodeCenter(node);
  };
  return [at(edge.from), at(edge.to)];
}

/** Center to center: nodes are opaque and drawn over the edges, so a line meets each border. */
export function edgePath(graph: WorkflowGraph, edge: WorkflowGraphEdge): string {
  const [a, b] = endpoints(graph, edge);
  if (edge.kind === "bypass") {
    const lane = graphAcross(graph);
    return `M ${pair(a)} C ${pair({ along: a.along, across: lane })}, ${pair({ along: b.along, across: lane })}, ${pair(b)}`;
  }
  const middle = (a.along + b.along) / 2;
  return `M ${pair(a)} C ${pair({ along: middle, across: a.across })}, ${pair({ along: middle, across: b.across })}, ${pair(b)}`;
}

/** Midpoint of an edge's curve, where a new-session mark sits. */
export function edgeMidpoint(graph: WorkflowGraph, edge: WorkflowGraphEdge): GraphPoint {
  const [a, b] = endpoints(graph, edge);
  const along = (a.along + b.along) / 2;
  if (edge.kind === "bypass") {
    return { along, across: (a.across + b.across) / 8 + (graphAcross(graph) * 3) / 4 };
  }
  return { along, across: (a.across + b.across) / 2 };
}

/** A point as percentages of the drawing, for undistorted marks. */
export function percentOf(graph: WorkflowGraph, point: GraphPoint): { x: string; y: string } {
  return { x: percent(point.across, graphAcross(graph)), y: percent(point.along, graph.columns) };
}

/** A column range's vertical extent as percentages of the drawing: a band or the cycle. */
export function bandSpan(
  graph: WorkflowGraph,
  band: { from: number; to: number },
): { top: string; height: string } {
  return {
    top: percent(band.from, graph.columns),
    height: percent(band.to - band.from, graph.columns),
  };
}
