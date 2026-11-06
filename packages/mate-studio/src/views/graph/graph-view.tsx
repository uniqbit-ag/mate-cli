import { useQuery } from "@tanstack/react-query";
import {
  capabilityNodeId,
  GRAPH_EDGE_KINDS,
  type StudioGraphEdgeKind,
  type StudioSpecGraph,
} from "@uniqbit/mate-core/studio";
import { lazy, Suspense, useId, useMemo, useState } from "react";

import { Icon } from "../../components/icon";
import { EmptyNote, PAGE_PAD } from "../../components/view-parts";
import { cn } from "../../lib/cn";
import type { StudioSearch } from "../../lib/search";
import { graphQuery } from "../../lib/studio-queries";
import { SidePanel } from "../../shell/panel";
import { GraphPanelBody } from "./graph-panel";
import {
  type EdgeFilter,
  forEachEdge,
  type GraphSelection,
  indexNodes,
  matchHint,
  NO_FILTER,
  searchNodes,
  selectionId,
  selectionTitle,
} from "./model";

/** The renderer is its own chunk: only a graph with specs loads it. */
const GraphCanvas = lazy(() => import("./graph-canvas"));

const EDGE_LABELS: Record<StudioGraphEdgeKind, string> = {
  binds: "Areas",
  in: "Repositories",
  mentions: "Mentions",
  "co-change": "Changed together",
};

interface GraphViewProps {
  search: StudioSearch;
  /** The selected node id from the address. */
  node?: string;
  onNodeChange: (node: string | undefined) => void;
}

export function GraphView({ search, node, onNodeChange }: GraphViewProps) {
  const graph = useQuery({
    ...graphQuery(search.companion ?? ""),
    enabled: Boolean(search.companion),
  });
  // A failed refetch keeps the graph already shown.
  if (graph.data) {
    return (
      <LoadedGraph wire={graph.data} search={search} node={node} onNodeChange={onNodeChange} />
    );
  }
  if (graph.isError) {
    return (
      <section className={cn(PAGE_PAD, "pb-10")}>
        <EmptyNote>The spec graph could not be built: {graph.error.message}</EmptyNote>
      </section>
    );
  }
  return (
    <section className={cn(PAGE_PAD, "pb-10")}>
      <p className="m-0 text-sm text-muted">Building the spec graph…</p>
    </section>
  );
}

function LoadedGraph({
  wire,
  search,
  node,
  onNodeChange,
}: GraphViewProps & { wire: StudioSpecGraph }) {
  const index = useMemo(() => indexNodes(wire), [wire]);
  const [filter, setFilter] = useState<EdgeFilter>(NO_FILTER);
  const [edge, setEdge] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const capabilities = wire.nodes.filter((entry) => entry.kind === "capability").length;

  // An unknown node selects nothing.
  const selectedNode = node !== undefined && index.byId.has(node) ? node : null;
  const selection: GraphSelection | null =
    edge !== null ? { edge } : selectedNode ? { node: selectedNode } : null;

  const selectNode = (id: string | null) => {
    setEdge(null);
    onNodeChange(id ?? undefined);
  };
  const focusNode = (id: string) => {
    selectNode(id);
    setFocus((previous) => ({ id, nonce: (previous?.nonce ?? 0) + 1 }));
  };

  if (capabilities === 0) {
    return (
      <section className={cn(PAGE_PAD, "pb-10")}>
        <EmptyNote>No specs in this companion.</EmptyNote>
      </section>
    );
  }

  const panelCurrent = selectionId(selection);
  return (
    <section
      className={cn(PAGE_PAD, "flex min-h-[480px] flex-1 flex-col gap-2 pb-4")}
      aria-label="Spec graph"
      data-graph-view
    >
      <GraphToolbar wire={wire} filter={filter} onFilter={setFilter} onFocus={focusNode} />
      <Problems wire={wire} onSelectNode={focusNode} />
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-card border border-rule">
        <Suspense fallback={<p className="m-0 p-4 text-sm text-muted">Loading the renderer…</p>}>
          <GraphCanvas
            wire={wire}
            filter={filter}
            selected={selectedNode}
            focus={focus}
            onSelectNode={selectNode}
            onSelectEdge={(next) => {
              onNodeChange(undefined);
              setEdge(next);
            }}
          />
        </Suspense>
        <Legend />
      </div>
      <SidePanel
        items={panelCurrent ? [panelCurrent] : []}
        current={panelCurrent}
        onSelect={(id) => {
          if (id === null) selectNode(null);
        }}
        wide
        title={selection ? selectionTitle(wire, index, selection) : "Graph"}
      >
        {selection ? (
          <GraphPanelBody
            selection={selection}
            wire={wire}
            index={index}
            search={search}
            onSelectNode={focusNode}
          />
        ) : null}
      </SidePanel>
    </section>
  );
}

function GraphToolbar({
  wire,
  filter,
  onFilter,
  onFocus,
}: {
  wire: StudioSpecGraph;
  filter: EdgeFilter;
  onFilter: (filter: EdgeFilter) => void;
  onFocus: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const listId = useId();
  const matches = useMemo(() => searchNodes(wire, query), [wire, query]);
  const maxWeight = useMemo(() => {
    let max = 1;
    forEachEdge(wire, (_source, _target, kind, weight) => {
      if (kind === "co-change") max = Math.max(max, weight);
    });
    return max;
  }, [wire]);
  const toggle = (kind: StudioGraphEdgeKind) => {
    const hidden = new Set(filter.hidden);
    if (hidden.has(kind)) hidden.delete(kind);
    else hidden.add(kind);
    onFilter({ ...filter, hidden });
  };

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
      role="toolbar"
      aria-label="Graph controls"
    >
      <form
        className="relative"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (matches[0]) {
            onFocus(matches[0].id);
            setQuery("");
          }
        }}
      >
        <label className="flex h-8 items-center gap-2 rounded-control border border-rule bg-surface px-2.5">
          <Icon name="search" className="size-3.5 text-muted" />
          <span className="sr-only">Find a spec, Area or repository</span>
          <input
            className="w-56 border-0 bg-transparent text-sm text-text outline-none placeholder:text-muted"
            placeholder="Find a spec, Area or repository"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-controls={listId}
            aria-autocomplete="list"
            data-graph-search
          />
        </label>
        {matches.length > 0 ? (
          <ul
            id={listId}
            className="absolute top-9 left-0 z-20 m-0 grid w-80 list-none gap-0.5 rounded-control border border-rule bg-surface p-1 shadow-float"
            aria-label="Matches"
          >
            {matches.map((match) => (
              <li key={match.id}>
                <button
                  type="button"
                  className="flex w-full items-baseline gap-2 rounded-[4px] border-0 bg-transparent px-2 py-1 text-left text-sm text-text hover:bg-page"
                  onClick={() => {
                    onFocus(match.id);
                    setQuery("");
                  }}
                >
                  <span className="min-w-0 truncate font-mono">{match.label}</span>
                  <span className="ml-auto text-2xs text-muted">{matchHint(match)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </form>
      <fieldset className="m-0 flex flex-wrap items-center gap-3 border-0 p-0">
        <legend className="sr-only">Connections shown</legend>
        {GRAPH_EDGE_KINDS.map((kind) => (
          <label key={kind} className="inline-flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={!filter.hidden.has(kind)}
              onChange={() => toggle(kind)}
              data-graph-edge-kind={kind}
            />
            {EDGE_LABELS[kind]}
          </label>
        ))}
      </fieldset>
      {maxWeight > 1 ? (
        <label className="inline-flex items-center gap-2 text-xs text-muted">
          Changed together at least
          <input
            type="range"
            min={1}
            max={maxWeight}
            value={filter.minWeight}
            onChange={(event) => onFilter({ ...filter, minWeight: Number(event.target.value) })}
            disabled={filter.hidden.has("co-change")}
            data-graph-min-weight
          />
          <span className="w-4 font-mono tabular-nums">{filter.minWeight}×</span>
        </label>
      ) : null}
    </div>
  );
}

/** Unbound specs and broken links, folded so they never push the graph away. */
function Problems({
  wire,
  onSelectNode,
}: {
  wire: StudioSpecGraph;
  onSelectNode: (id: string) => void;
}) {
  if (wire.unbound.length === 0 && wire.broken.length === 0) return null;
  const parts = [
    wire.unbound.length > 0
      ? `${wire.unbound.length} unbound ${wire.unbound.length === 1 ? "spec" : "specs"}`
      : null,
    wire.broken.length > 0
      ? `${wire.broken.length} broken ${wire.broken.length === 1 ? "link" : "links"}`
      : null,
  ].filter(Boolean);
  return (
    <details className="text-xs text-muted" data-graph-problems>
      <summary className="cursor-pointer text-warn">{parts.join(" · ")}</summary>
      <div className="grid gap-2 pt-2">
        {wire.unbound.length > 0 ? (
          <div>
            <p className="m-0">
              Their frontmatter names no repository or no Area, so they bind nothing:
            </p>
            <p className="m-0 flex flex-wrap gap-x-2 font-mono">
              {wire.unbound.map((capability) => (
                <button
                  key={capability}
                  type="button"
                  className="border-0 bg-transparent p-0 text-text hover:text-accent"
                  onClick={() => onSelectNode(capabilityNodeId(capability))}
                >
                  {capability}
                </button>
              ))}
            </p>
          </div>
        ) : null}
        {wire.broken.length > 0 ? (
          <ul className="m-0 grid list-none gap-0.5 p-0 font-mono" aria-label="Broken links">
            {wire.broken.map((link) => (
              <li key={`${link.from}>${link.target}`}>
                {link.from} → <span className="text-bad">{link.target}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

function Legend() {
  return (
    <ul
      className="pointer-events-none absolute top-2 left-2 m-0 flex list-none gap-3 rounded-control bg-[color-mix(in_srgb,var(--panel)_85%,transparent)] px-2 py-1 text-2xs text-muted"
      aria-label="Legend"
    >
      <li className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-accent" aria-hidden="true" /> Spec
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span className="size-2 rotate-45 bg-info" aria-hidden="true" /> Area
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span className="size-2 bg-why" aria-hidden="true" /> Repository
      </li>
    </ul>
  );
}
