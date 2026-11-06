import { GRAPH_EDGE_STRIDE, type StudioSpecGraph } from "@uniqbit/mate-core/studio";
import type { Attributes } from "graphology-types";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import { inferSettings } from "graphology-layout-forceatlas2";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Sigma } from "sigma";
import { extremityArrow, sdfCircle, sdfDiamond, sdfSquare } from "sigma/rendering";

import { type EdgeAttributes, type EdgeFilter, layoutWeight, type NodeAttributes } from "./model";
import { filterEdges, type SpecGraph, toGraphology } from "./spec-graph";

/**
 * The WebGL canvas: Sigma renders, ForceAtlas2 lays out in a Web Worker. Loaded only by the
 * Graph view, so no other view carries the renderer.
 */

interface GraphCanvasProps {
  wire: StudioSpecGraph;
  filter: EdgeFilter;
  /** The selected node id; it and its neighbours stay highlighted. */
  selected: string | null;
  /** Each new value moves the camera to that node. */
  focus: { id: string; nonce: number } | null;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (index: number) => void;
}

/** Laid-out positions per wire graph, so a revisit draws at once and runs no layout. */
const settled = new WeakMap<StudioSpecGraph, { x: number; y: number }[]>();

/** How long the pointer rests on a node before it and its neighbours are highlighted. */
const HOVER_REST_MS = 70;

/** Above this many nodes the layout's positions are shown every `STEP_MS`, not every step. */
const STEPPED_LAYOUT_ORDER = 2_000;
const STEP_MS = 1_000;

/** Layout runs at most this long; large graphs get longer, capped. */
const layoutBudget = (order: number) => Math.min(15_000, 3_000 + order * 0.6);

interface Palette {
  text: string;
  muted: string;
  accent: string;
  info: string;
  why: string;
  border: string;
  panel: string;
}

function readPalette(element: Element): Palette {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string) =>
    style.getPropertyValue(`--${name}`).trim() || fallback;
  return {
    text: token("text", "#e8e6e1"),
    muted: token("muted", "#8a8f8a"),
    accent: token("accent", "#7fb069"),
    info: token("info", "#6fa8dc"),
    why: token("why", "#caa8ff"),
    border: token("border", "#3a3f3a"),
    panel: token("panel", "#1d211e"),
  };
}

function nodeColor(palette: Palette, kind: NodeAttributes["kind"]): string {
  if (kind === "repository") return palette.why;
  if (kind === "area") return palette.info;
  return palette.accent;
}

function edgeColor(palette: Palette, kind: EdgeAttributes["kind"]): string {
  if (kind === "mentions") return palette.text;
  if (kind === "co-change") return palette.accent;
  return palette.muted;
}

const SHAPES: Record<NodeAttributes["kind"], string> = {
  repository: "square",
  area: "diamond",
  capability: "circle",
};

/** What the styles read, as attributes; written again only when the theme changes. */
interface NodePaint {
  color: string;
  fadedColor: string;
  labelColor: string;
  fadedLabelColor: string;
  backdropColor: string;
  shape: string;
  hoverSize: number;
}

interface EdgePaint {
  color: string;
  fadedColor: string;
  opacity: number;
  head: string;
}

/** Set on everything outside a highlight. */
type FadeState = { isFaded: boolean };

type PaintedNode = NodeAttributes & Partial<NodePaint>;
type PaintedEdge = EdgeAttributes & Partial<EdgePaint>;

/** Writes the theme's colours onto every node and edge. */
function paint(graph: SpecGraph, palette: Palette): void {
  graph.updateEachNodeAttributes((_node, attributes) => ({
    ...attributes,
    color: nodeColor(palette, attributes.kind),
    fadedColor: palette.border,
    labelColor: palette.text,
    fadedLabelColor: palette.muted,
    backdropColor: palette.panel,
    shape: SHAPES[attributes.kind],
    hoverSize: attributes.size * 1.4,
  }));
  graph.updateEachEdgeAttributes((_edge, attributes) => ({
    ...attributes,
    color: edgeColor(palette, attributes.kind),
    fadedColor: palette.border,
    opacity: attributes.kind === "co-change" ? 0.45 : 0.6,
    head: attributes.kind === "mentions" ? "arrow" : "none",
  }));
}

/**
 * Styles are attribute bindings and item-state conditionals only: Sigma re-evaluates a style
 * function on every camera move, which on large graphs costs whole frames.
 */
// oxlint-disable unicorn/no-thenable -- Sigma's style conditionals are `{ whenState, then }` objects
function createRenderer(graph: SpecGraph, container: HTMLElement) {
  return new Sigma<PaintedNode, PaintedEdge, Attributes, FadeState, FadeState>(graph, container, {
    primitives: {
      nodes: { shapes: [sdfCircle(), sdfSquare(), sdfDiamond()] },
      edges: { extremities: [extremityArrow()] },
    },
    customNodeState: { isFaded: false },
    customEdgeState: { isFaded: false },
    styles: {
      nodes: [
        {
          x: { attribute: "x" },
          y: { attribute: "y" },
          label: { attribute: "label" },
          shape: { attribute: "shape" },
          size: { attribute: "size" },
          color: { attribute: "color" },
          labelColor: { attribute: "labelColor" },
          labelVisibility: "auto",
          depth: "nodes",
          visibility: { whenState: "isHidden", then: "hidden", else: "visible" },
          backdropVisibility: "hidden",
          backdropColor: { attribute: "backdropColor" },
          backdropShadowColor: "rgba(0, 0, 0, 0.35)",
          backdropShadowBlur: 10,
          backdropPadding: 5,
        },
        {
          whenState: "isFaded",
          then: {
            color: { attribute: "fadedColor" },
            labelColor: { attribute: "fadedLabelColor" },
          },
        },
        { whenState: "isHighlighted", then: { labelVisibility: "visible", depth: "topNodes" } },
        {
          whenState: "isHovered",
          then: {
            size: { attribute: "hoverSize" },
            labelVisibility: "visible",
            depth: "topNodes",
            backdropVisibility: "visible",
          },
        },
      ],
      edges: [
        {
          size: { attribute: "size" },
          color: { attribute: "color" },
          opacity: { attribute: "opacity" },
          head: { attribute: "head" },
          depth: "edges",
          visibility: { whenState: "isHidden", then: "hidden", else: "visible" },
        },
        { whenState: "isFaded", then: { color: { attribute: "fadedColor" }, opacity: 0.15 } },
        { whenState: "isHighlighted", then: { opacity: 0.9, depth: "topEdges" } },
      ],
    },
    settings: {
      // The panel and narrow layouts may briefly collapse the container; Sigma resizes after.
      allowInvalidContainer: true,
      enableEdgeEvents: true,
      enableNodeDrag: true,
      // Large graphs drop edges and labels while the camera moves, so panning stays smooth.
      hideEdgesOnMove: graph.size > 50_000,
      hideLabelsOnMove: graph.order > 5_000,
      labelDensity: 0.6,
      labelRenderedSizeThreshold: 6,
    },
  });
}

// oxlint-enable unicorn/no-thenable

type Renderer = ReturnType<typeof createRenderer>;

/** The node and its direct neighbours, with the edges between them. */
function neighbourhood(graph: SpecGraph, node: string) {
  return { nodes: [node, ...graph.neighbors(node)], edges: graph.edges(node) };
}

export default function GraphCanvas({
  wire,
  filter,
  selected,
  focus,
  onSelectNode,
  onSelectEdge,
}: GraphCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const graphRef = useRef<SpecGraph | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const shownRef = useRef<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] });
  const fadedRef = useRef(false);
  // The wire graph whose layout finished in this mount; a held layout never runs.
  const [laidOut, setLaidOut] = useState<StudioSpecGraph | null>(null);
  const laying = wire.nodes.length > 1 && laidOut !== wire && !settled.has(wire);
  const selectNode = useEffectEvent(onSelectNode);
  const selectEdge = useEffectEvent(onSelectEdge);

  /** Highlights the hovered node, else the selected one, with its neighbours. */
  const highlight = useEffectEvent((chosen: string | null = selected) => {
    const sigma = renderer.current;
    const graph = graphRef.current;
    if (!sigma || !graph) return;
    const target = hoveredRef.current ?? chosen;
    const next =
      target && graph.hasNode(target) ? neighbourhood(graph, target) : { nodes: [], edges: [] };
    const fading = next.nodes.length > 0;
    // Everything fades once when a highlight starts and clears once when it ends.
    if (fading !== fadedRef.current) {
      sigma.setNodesState(graph.nodes(), { isFaded: fading });
      sigma.setEdgesState(graph.edges(), { isFaded: fading });
      fadedRef.current = fading;
    } else if (fading) {
      sigma.setNodesState(shownRef.current.nodes, { isFaded: true });
      sigma.setEdgesState(shownRef.current.edges, { isFaded: true });
    }
    sigma.setNodesState(shownRef.current.nodes, { isHighlighted: false });
    sigma.setEdgesState(shownRef.current.edges, { isHighlighted: false });
    shownRef.current = next;
    sigma.setNodesState(next.nodes, { isHighlighted: true, isFaded: false });
    sigma.setEdgesState(next.edges, { isHighlighted: true, isFaded: false });
  });

  const applyFilter = useEffectEvent((shown: EdgeFilter = filter) => {
    const sigma = renderer.current;
    const graph = graphRef.current;
    if (!sigma || !graph) return;
    const { hide, show } = filterEdges(graph, shown);
    sigma.setEdgesState(hide, { isHidden: true });
    sigma.setEdgesState(show, { isHidden: false });
  });

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const held = settled.get(wire);
    const graph = toGraphology(wire, held);
    paint(graph, readPalette(element));
    const sigma = createRenderer(graph, element);
    graphRef.current = graph;
    renderer.current = sigma;
    shownRef.current = { nodes: [], edges: [] };
    fadedRef.current = false;
    hoveredRef.current = null;
    applyFilter();
    highlight();

    // Highlighting restyles every node and edge, so a pointer sweeping across the graph or
    // panning it does not highlight on the way; only a rest on a node does.
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    const hover = (node: string | null) => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        const { isPanning, isDragging } = sigma.getGraphState();
        if (node && (isPanning || isDragging)) return;
        if (hoveredRef.current === node) return;
        hoveredRef.current = node;
        highlight();
      }, HOVER_REST_MS);
    };
    const onEnterNode = ({ node }: { node: string }) => hover(node);
    const onLeaveNode = () => hover(null);
    const onClickNode = ({ node }: { node: string }) => selectNode(node);
    const onClickEdge = ({ edge }: { edge: string }) => selectEdge(Number(edge.slice(1)));
    const onClickStage = () => selectNode(null);
    sigma.on("enterNode", onEnterNode);
    sigma.on("leaveNode", onLeaveNode);
    sigma.on("clickNode", onClickNode);
    sigma.on("clickEdge", onClickEdge);
    sigma.on("clickStage", onClickStage);

    // Theme changes repaint the attributes the styles read.
    const recolor = () => paint(graph, readPalette(element));
    const themes = new MutationObserver(recolor);
    themes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    const scheme = window.matchMedia("(prefers-color-scheme: light)");
    scheme.addEventListener("change", recolor);

    let layout: FA2Layout | null = null;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let syncTimer: ReturnType<typeof setInterval> | undefined;
    // Small graphs animate every layout step; large ones lay out a copy and show it in steps,
    // so the renderer does not reprocess every node and edge on each iteration.
    const stepped = graph.order > STEPPED_LAYOUT_ORDER;
    const layoutGraph = stepped ? graph.copy() : graph;
    const sync = () => {
      if (!stepped) return;
      graph.updateEachNodeAttributes(
        (node, attributes) => {
          const { x, y } = layoutGraph.getNodeAttributes(node);
          return { ...attributes, x, y };
        },
        { attributes: ["x", "y"] },
      );
    };
    const keep = () => {
      sync();
      settled.set(
        wire,
        wire.nodes.map((node) => {
          const { x, y } = graph.getNodeAttributes(node.id);
          return { x, y };
        }),
      );
    };
    if (!held && graph.order > 1) {
      layout = new FA2Layout(layoutGraph, {
        settings: {
          ...inferSettings(layoutGraph),
          barnesHutOptimize: graph.order > 1_000,
          adjustSizes: false,
          edgeWeightInfluence: 1,
          gravity: 0.5,
        },
        getEdgeWeight: (_edge, attributes) => layoutWeight(attributes as EdgeAttributes),
      });
      layout.start();
      if (stepped) syncTimer = setInterval(sync, STEP_MS);
      stopTimer = setTimeout(() => {
        clearInterval(syncTimer);
        layout?.stop();
        keep();
        setLaidOut(wire);
      }, layoutBudget(graph.order));
    }

    return () => {
      clearTimeout(stopTimer);
      clearTimeout(hoverTimer);
      clearInterval(syncTimer);
      if (layout) {
        // A layout cut short still keeps how far it got.
        if (layout.isRunning()) keep();
        layout.kill();
      }
      themes.disconnect();
      scheme.removeEventListener("change", recolor);
      sigma.off("enterNode", onEnterNode);
      sigma.off("leaveNode", onLeaveNode);
      sigma.off("clickNode", onClickNode);
      sigma.off("clickEdge", onClickEdge);
      sigma.off("clickStage", onClickStage);
      sigma.kill();
      renderer.current = null;
      graphRef.current = null;
    };
  }, [wire]);

  useEffect(() => highlight(selected), [selected]);
  useEffect(() => applyFilter(filter), [filter]);

  useEffect(() => {
    const sigma = renderer.current;
    if (!sigma || !focus) return;
    const display = sigma.getNodeDisplayData(focus.id);
    if (!display) return;
    void sigma.getCamera().animate({ x: display.x, y: display.y, ratio: 0.25 }, { duration: 500 });
  }, [focus]);

  return (
    <div className="relative h-full min-h-[360px] w-full">
      <div
        ref={container}
        className="graph-canvas absolute inset-0"
        role="img"
        aria-label={`Spec graph: ${wire.nodes.length} nodes, ${wire.edges.length / GRAPH_EDGE_STRIDE} edges`}
      />
      {laying ? (
        <span
          className="pointer-events-none absolute right-3 bottom-3 text-2xs text-muted"
          aria-live="polite"
        >
          Laying out…
        </span>
      ) : null}
    </div>
  );
}
