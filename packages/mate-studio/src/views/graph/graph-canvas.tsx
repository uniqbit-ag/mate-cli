import { GRAPH_EDGE_STRIDE, type StudioSpecGraph } from "@uniqbit/mate-core/studio";
import type { Attributes } from "graphology-types";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import { inferSettings } from "graphology-layout-forceatlas2";
import { useEffect, useEffectEvent, useRef } from "react";
import { Sigma } from "sigma";

import { cssColor, DEPTH_LAYERS, DIM_DEPTH, dimLayer } from "./dim-layer";
import {
  type EdgeAttributes,
  type EdgeFilter,
  edgeVisible,
  layoutWeight,
  type NodeAttributes,
  placeNodes,
  type Point,
} from "./model";
import { filterEdges, type SpecGraph, toGraphology } from "./spec-graph";

/**
 * The WebGL canvas: Sigma renders, ForceAtlas2 lays out in a Web Worker. Loaded only by the
 * Graph view, so no other view carries the renderer.
 */

interface GraphCanvasProps {
  wire: StudioSpecGraph;
  /** Whose graph this is; laid-out positions are held per key, so a rebuild keeps them. */
  layoutKey: string;
  filter: EdgeFilter;
  /** The selected node id; it and its neighbours stay highlighted. */
  selected: string | null;
  /** Each new value moves the camera to that node. */
  focus: { id: string; nonce: number } | null;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (index: number) => void;
}

/**
 * Laid-out positions per layout key and node id, so a revisit draws at once and runs no layout,
 * and a rebuilt graph lays out only around the nodes it adds.
 */
const settled = new Map<string, ReadonlyMap<string, Point>>();

/** How long the pointer rests on a node before it and its neighbours are highlighted. */
const HOVER_REST_MS = 70;

/** Above this many nodes the layout's positions are shown in steps, not every iteration. */
const STEPPED_LAYOUT_ORDER = 2_000;
/** Each step re-indexes the graph, so larger graphs step less often: 1s, up to 3s at 150k. */
const stepMs = (order: number) => Math.min(3_000, Math.max(1_000, order / 50));

/** Layout runs at most this long; large graphs get longer, capped. */
const layoutBudget = (order: number) => Math.min(15_000, 3_000 + order * 0.6);
/** Share of the full budget a layout gets when most nodes keep held positions. */
const MIN_BUDGET_SHARE = 0.2;

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

/**
 * Edges are quiet hairlines in the muted tone, so thousands of them read as texture rather than
 * a fill; only a highlight gives them colour. Mentions are a little stronger than the rest.
 */
const EDGE_OPACITY: Record<EdgeAttributes["kind"], number> = {
  binds: 0.18,
  in: 0.18,
  "co-change": 0.22,
  mentions: 0.45,
};

/** What the styles read, as attributes; written again only when the theme changes. */
interface NodePaint {
  color: string;
  labelColor: string;
  backdropColor: string;
  hoverSize: number;
}

interface EdgePaint {
  color: string;
  highlightColor: string;
  opacity: number;
}

/** How much the veil covers the rest of the graph while something is highlighted. */
const DIM_ALPHA = 0.78;

type PaintedNode = NodeAttributes & Partial<NodePaint>;
type PaintedEdge = EdgeAttributes & Partial<EdgePaint>;

/** Writes the theme's colours onto every node and edge. */
function paint(graph: SpecGraph, palette: Palette): void {
  graph.updateEachNodeAttributes((_node, attributes) => ({
    ...attributes,
    color: nodeColor(palette, attributes.kind),
    labelColor: palette.text,
    backdropColor: palette.panel,
    hoverSize: attributes.size * 1.6,
  }));
  graph.updateEachEdgeAttributes((_edge, attributes) => ({
    ...attributes,
    color: attributes.kind === "mentions" ? palette.text : palette.muted,
    highlightColor:
      attributes.kind === "binds" || attributes.kind === "in" ? palette.info : palette.accent,
    opacity: EDGE_OPACITY[attributes.kind],
  }));
}

const PRIMITIVES = { depthLayers: DEPTH_LAYERS };

/**
 * Styles are attribute bindings and item-state conditionals only: Sigma re-evaluates a style
 * function on every camera move, which on large graphs costs whole frames. Every node is a
 * circle; kind shows in colour and size, which stays legible when the whole graph is in view.
 */
// oxlint-disable unicorn/no-thenable -- Sigma's style conditionals are `{ whenState, then }` objects
function createRenderer(graph: SpecGraph, container: HTMLElement) {
  return new Sigma<PaintedNode, PaintedEdge, Attributes, object, object, object, typeof PRIMITIVES>(
    graph,
    container,
    {
      primitives: PRIMITIVES,
      styles: {
        nodes: [
          {
            x: { attribute: "x" },
            y: { attribute: "y" },
            label: { attribute: "label" },
            size: { attribute: "size" },
            color: { attribute: "color" },
            labelColor: { attribute: "labelColor" },
            labelVisibility: "auto",
            depth: "nodes",
            visibility: { whenState: "isHidden", then: "hidden", else: "visible" },
            backdropVisibility: "hidden",
            backdropColor: { attribute: "backdropColor" },
            backdropShadowColor: "rgba(0, 0, 0, 0.3)",
            backdropShadowBlur: 8,
            backdropPadding: 4,
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
            depth: "edges",
            visibility: { whenState: "isHidden", then: "hidden", else: "visible" },
          },
          {
            whenState: "isHighlighted",
            then: { color: { attribute: "highlightColor" }, opacity: 0.85, depth: "topEdges" },
          },
        ],
      },
      settings: {
        // The panel and narrow layouts may briefly collapse the container; Sigma resizes after.
        allowInvalidContainer: true,
        enableEdgeEvents: true,
        enableNodeDrag: true,
        // Sigma's default floor is 1.7px, which turns large graphs into a solid fill.
        minEdgeThickness: 0.5,
        // No hideEdgesOnMove/hideLabelsOnMove: Sigma re-indexes the whole graph on every release
        // to restore them, which freezes large graphs after each pan.
        labelDensity: 0.6,
        labelRenderedSizeThreshold: 6,
      },
    },
  );
}

// oxlint-enable unicorn/no-thenable

type Renderer = ReturnType<typeof createRenderer>;

/** The node and its neighbours over edges `filter` shows, with those edges. */
function neighbourhood(graph: SpecGraph, node: string, filter: EdgeFilter) {
  const nodes = new Set([node]);
  const edges: string[] = [];
  graph.forEachEdge(node, (edge, attributes, source, target) => {
    if (!edgeVisible(attributes, filter)) return;
    edges.push(edge);
    nodes.add(source === node ? target : source);
  });
  return { nodes: [...nodes], edges };
}

export default function GraphCanvas({
  wire,
  layoutKey,
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
  // Whether the veil is drawn, and in which colour; read by the dim layer on every frame.
  const dimRef = useRef(false);
  const dimColorRef = useRef<readonly [number, number, number, number]>([0, 0, 0, DIM_ALPHA]);
  // Shown while the layout worker runs; the layout's lifecycle toggles it, not React state.
  const layingNote = useRef<HTMLSpanElement>(null);
  const selectNode = useEffectEvent(onSelectNode);
  const selectEdge = useEffectEvent(onSelectEdge);

  /** Highlights the hovered node, else the selected one, with its neighbours. */
  const highlight = useEffectEvent((chosen: string | null = selected) => {
    const sigma = renderer.current;
    const graph = graphRef.current;
    if (!sigma || !graph) return;
    const target = hoveredRef.current ?? chosen;
    const next =
      target && graph.hasNode(target)
        ? neighbourhood(graph, target, filter)
        : { nodes: [], edges: [] };
    // Only the neighbourhood changes state; the veil dims everything else at once.
    sigma.setNodesState(shownRef.current.nodes, { isHighlighted: false });
    sigma.setEdgesState(shownRef.current.edges, { isHighlighted: false });
    shownRef.current = next;
    sigma.setNodesState(next.nodes, { isHighlighted: true });
    sigma.setEdgesState(next.edges, { isHighlighted: true });
    dimRef.current = next.nodes.length > 0;
    sigma.scheduleRender();
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
    const note = layingNote.current;
    const showLaying = (shown: boolean) => {
      if (note) note.hidden = !shown;
    };
    const held = settled.get(layoutKey);
    const { positions, missing } = placeNodes(wire, held);
    const graph = toGraphology(wire, positions);
    let palette = readPalette(element);
    paint(graph, palette);
    dimColorRef.current = cssColor(palette.panel, DIM_ALPHA);
    const sigma = createRenderer(graph, element);
    sigma.addCustomLayerProgram(
      DIM_DEPTH,
      DIM_DEPTH,
      dimLayer(
        () => dimRef.current,
        () => dimColorRef.current,
      ),
    );
    graphRef.current = graph;
    renderer.current = sigma;
    shownRef.current = { nodes: [], edges: [] };
    dimRef.current = false;
    hoveredRef.current = null;
    applyFilter();
    highlight();

    // A pointer sweeping across the graph or panning it does not highlight every node on the
    // way, which would flash the veil; only a rest on a node does.
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

    // Theme changes repaint the attributes the styles read; other class changes repaint nothing.
    const recolor = () => {
      const next = readPalette(element);
      if (JSON.stringify(next) === JSON.stringify(palette)) return;
      palette = next;
      paint(graph, next);
      dimColorRef.current = cssColor(next.panel, DIM_ALPHA);
    };
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
      settled.set(
        layoutKey,
        new Map(
          wire.nodes.map((node) => {
            const { x, y } = graph.getNodeAttributes(node.id);
            return [node.id, { x, y }];
          }),
        ),
      );
    };
    const finish = () => {
      clearTimeout(stopTimer);
      clearInterval(syncTimer);
      layout?.stop();
      sync();
      keep();
      showLaying(false);
    };
    // A drag takes over from the layout, which would otherwise move the node back.
    const onDragStart = () => {
      if (layout?.isRunning()) finish();
    };
    sigma.on("nodeDragStart", onDragStart);
    sigma.on("nodeDragEnd", keep);
    if (missing > 0 && graph.order > 1) {
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
      if (stepped) {
        // A step while the viewer pans, zooms or drags would freeze that gesture; it waits.
        syncTimer = setInterval(() => {
          const { isPanning, isZooming, isDragging } = sigma.getGraphState();
          if (!isPanning && !isZooming && !isDragging) sync();
        }, stepMs(graph.order));
      }
      const share = held ? Math.max(MIN_BUDGET_SHARE, missing / graph.order) : 1;
      stopTimer = setTimeout(finish, layoutBudget(graph.order) * share);
      showLaying(true);
    }

    return () => {
      clearTimeout(stopTimer);
      clearTimeout(hoverTimer);
      clearInterval(syncTimer);
      if (layout) {
        // A layout cut short still keeps how far it got.
        if (layout.isRunning()) {
          sync();
          keep();
        }
        layout.kill();
        showLaying(false);
      }
      themes.disconnect();
      scheme.removeEventListener("change", recolor);
      sigma.off("enterNode", onEnterNode);
      sigma.off("leaveNode", onLeaveNode);
      sigma.off("clickNode", onClickNode);
      sigma.off("clickEdge", onClickEdge);
      sigma.off("clickStage", onClickStage);
      sigma.off("nodeDragStart", onDragStart);
      sigma.off("nodeDragEnd", keep);
      sigma.removeCustomLayerProgram(DIM_DEPTH);
      sigma.kill();
      renderer.current = null;
      graphRef.current = null;
    };
  }, [wire, layoutKey]);

  useEffect(() => highlight(selected), [selected]);
  useEffect(() => {
    applyFilter(filter);
    highlight();
  }, [filter]);

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
      <span
        ref={layingNote}
        hidden
        className="pointer-events-none absolute right-3 bottom-3 text-2xs text-muted"
        aria-live="polite"
      >
        Laying out…
      </span>
    </div>
  );
}
