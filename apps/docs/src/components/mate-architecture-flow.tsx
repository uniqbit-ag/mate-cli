import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

type MateNodeData = {
  label: string;
  caption: string;
  tone: "companion" | "workspace" | "ide" | "git";
};

type CommandKind = "setup" | "launch" | "edit" | "git";

const nodes: Node<MateNodeData>[] = [
  node("companion", 380, 40, {
    label: "Companion repo",
    caption: "agent artifacts",
    tone: "companion",
  }),
  node("workspace", 380, 340, {
    label: "Workspace repo",
    caption: "product code",
    tone: "workspace",
  }),
  node("ide", 40, 190, {
    label: "IDE / VS Code",
    caption: "two-root workspace",
    tone: "ide",
  }),
  node("git", 720, 190, {
    label: "Git",
    caption: "separate histories",
    tone: "git",
  }),
];

const edges: Edge[] = [
  edge("companion", "workspace", "mate repo link", "setup"),
  edge("workspace", "companion", "MATE_REPO_PATH + MATE_ARTIFACT_PATH", "setup"),
  edge("ide", "workspace", "mate workspace open", "launch"),
  edge("ide", "companion", "open companion root", "launch"),
  edge("companion", "ide", "mate claude / opencode", "launch"),
  edge("ide", "workspace", "edit source + tests", "edit", "ide-workspace-edit"),
  edge("workspace", "git", "git status / commit", "git"),
  edge("companion", "git", "artifact commits", "git"),
  edge("companion", "workspace", "mate cap index", "edit", "cap-index"),
];

const nodeTypes = {
  mateNode: MateNode,
};

export function MateArchitectureFlow() {
  return (
    <section className="mate-flow not-prose overflow-hidden rounded-[2rem] border border-cyan-200/20 bg-slate-950 text-white shadow-2xl shadow-cyan-950/30">
      <style>{styles}</style>
      <div className="border-b border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.26),transparent_34%),radial-gradient(circle_at_top_right,rgba(168,85,247,0.2),transparent_32%)] px-5 py-5 sm:px-7">
        <p className="text-xs font-semibold uppercase tracking-[0.32em] text-cyan-200">Mate flow</p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          Four roots, command-labeled connections
        </h2>
      </div>

      <div className="h-[620px] bg-[linear-gradient(135deg,rgba(15,23,42,0.96),rgba(2,6,23,0.98))]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.46}
          maxZoom={1.35}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: false }}
        >
          <Background color="rgba(148, 163, 184, 0.22)" gap={28} />
          <MiniMap pannable zoomable nodeColor={miniMapColor} maskColor="rgba(2, 6, 23, 0.62)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </section>
  );
}

function node(id: string, x: number, y: number, data: MateNodeData): Node<MateNodeData> {
  return {
    id,
    position: { x, y },
    data,
    type: "mateNode",
  };
}

function edge(
  source: string,
  target: string,
  label: string,
  kind: CommandKind,
  id = `${source}-${target}-${kind}`,
): Edge {
  const color = edgeColor(kind);

  return {
    id,
    source,
    target,
    label,
    animated: true,
    type: "smoothstep",
    className: `mate-edge mate-edge-${kind}`,
    markerEnd: { type: MarkerType.ArrowClosed, color },
    style: { stroke: color, strokeWidth: 2.8 },
    labelStyle: { fill: "#f8fafc", fontSize: 13, fontWeight: 800 },
    labelBgStyle: { fill: "rgba(15, 23, 42, 0.92)", fillOpacity: 0.96 },
    labelBgPadding: [10, 5],
    labelBgBorderRadius: 999,
  };
}

function MateNode({ data }: { data: MateNodeData }) {
  const tone = nodeTone(data.tone);

  return (
    <div
      className={`mate-node grid h-32 w-64 place-items-center rounded-[2rem] border bg-gradient-to-br p-5 text-center shadow-2xl backdrop-blur ${tone.card}`}
    >
      <span className={`mate-node-pulse absolute right-5 top-5 h-3 w-3 rounded-full ${tone.dot}`} />
      <div>
        <div className="text-xl font-semibold leading-7 text-white">{data.label}</div>
        <div className={`mt-2 text-xs font-bold uppercase tracking-[0.22em] ${tone.caption}`}>
          {data.caption}
        </div>
      </div>
    </div>
  );
}

function edgeColor(kind: CommandKind) {
  switch (kind) {
    case "setup":
      return "#22d3ee";
    case "launch":
      return "#e879f9";
    case "edit":
      return "#fbbf24";
    case "git":
      return "#34d399";
  }
}

function nodeTone(tone: MateNodeData["tone"]) {
  switch (tone) {
    case "companion":
      return {
        card: "border-cyan-300/60 from-cyan-400/20 via-cyan-950/45 to-slate-950",
        dot: "bg-cyan-300 shadow-[0_0_22px_rgba(34,211,238,0.95)]",
        caption: "text-cyan-200",
      };
    case "workspace":
      return {
        card: "border-emerald-300/60 from-emerald-400/20 via-emerald-950/45 to-slate-950",
        dot: "bg-emerald-300 shadow-[0_0_22px_rgba(52,211,153,0.95)]",
        caption: "text-emerald-200",
      };
    case "ide":
      return {
        card: "border-fuchsia-300/60 from-fuchsia-400/20 via-fuchsia-950/45 to-slate-950",
        dot: "bg-fuchsia-300 shadow-[0_0_22px_rgba(232,121,249,0.95)]",
        caption: "text-fuchsia-200",
      };
    case "git":
      return {
        card: "border-orange-300/60 from-orange-400/20 via-orange-950/45 to-slate-950",
        dot: "bg-orange-300 shadow-[0_0_22px_rgba(253,186,116,0.95)]",
        caption: "text-orange-200",
      };
  }
}

function miniMapColor(node: Node<MateNodeData>) {
  switch (node.data.tone) {
    case "companion":
      return "#22d3ee";
    case "workspace":
      return "#34d399";
    case "ide":
      return "#e879f9";
    case "git":
      return "#fdba74";
  }
}

const styles = `
.mate-flow .react-flow__pane { cursor: grab; }
.mate-flow .react-flow__pane:active { cursor: grabbing; }
.mate-flow .react-flow__edge-path { filter: drop-shadow(0 0 9px currentColor); }
.mate-flow .react-flow__edge.animated .react-flow__edge-path {
  stroke-dasharray: 10 8;
  animation: mate-flow-dash 0.8s linear infinite;
}
.mate-flow .mate-edge-launch .react-flow__edge-path { animation-duration: 0.58s; }
.mate-flow .mate-edge-edit .react-flow__edge-path { animation-duration: 0.95s; }
.mate-flow .mate-edge-git .react-flow__edge-path { animation-duration: 1.15s; }
.mate-flow .react-flow__edge-textbg { backdrop-filter: blur(10px); }
.mate-node { position: relative; overflow: hidden; }
.mate-node::before {
  content: "";
  position: absolute;
  inset: -70% auto auto -45%;
  width: 78%;
  height: 240%;
  transform: rotate(24deg);
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.17), transparent);
  animation: mate-node-sheen 5s ease-in-out infinite;
}
.mate-node-pulse { animation: mate-node-pulse 1.7s ease-in-out infinite; }
@keyframes mate-flow-dash { to { stroke-dashoffset: -18; } }
@keyframes mate-node-sheen {
  0%, 42% { transform: translateX(-145%) rotate(24deg); }
  72%, 100% { transform: translateX(290%) rotate(24deg); }
}
@keyframes mate-node-pulse {
  0%, 100% { transform: scale(0.86); opacity: 0.72; }
  50% { transform: scale(1.22); opacity: 1; }
}
`;
