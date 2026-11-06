import { Link } from "@tanstack/react-router";
import {
  archivedArtifactPath,
  ROOT_AREA_LABEL,
  type StudioGraphArchive,
  type StudioGraphNode,
  type StudioSpecGraph,
} from "@uniqbit/mate-core/studio";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
import type { StudioSearch } from "../../lib/search";
import { PanelHead, PanelSection } from "../../shell/panel";
import { SpecDetail } from "../specs/specs-view";
import { edgeAt, type GraphSelection, type NodeIndex, sharedArchives } from "./model";

interface PanelProps {
  wire: StudioSpecGraph;
  index: NodeIndex;
  search: StudioSearch;
  onSelectNode: (id: string) => void;
}

const ARTIFACT_LABELS: Record<string, string> = {
  "proposal.md": "proposal",
  "design.md": "design",
  "tasks.md": "tasks",
  "verification.md": "verification",
};

const capabilityOf = (node: StudioGraphNode) => node.label;

function VaultLink({
  search,
  path,
  children,
}: {
  search: StudioSearch;
  path: string;
  children: ReactNode;
}) {
  return (
    <Link
      className="text-sm"
      to="/vault"
      search={{ companion: search.companion, studioMode: search.studioMode, path }}
    >
      {children}
    </Link>
  );
}

/** One archive's known artifacts, with the delta spec of each capability named. */
function ArchiveRow({
  archive,
  capabilities,
  search,
}: {
  archive: StudioGraphArchive;
  capabilities: string[];
  search: StudioSearch;
}) {
  return (
    <li
      className="grid gap-1 border-t border-rule-soft py-2 first:border-t-0"
      data-archive={archive.anchor}
    >
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 truncate font-mono text-sm">{archive.name}</span>
        <time className="ml-auto font-mono text-2xs text-muted" dateTime={archive.archivedOn}>
          {archive.archivedOn}
        </time>
      </span>
      <span className="flex flex-wrap gap-x-3 gap-y-1">
        {archive.artifacts.map((artifact) => (
          <VaultLink
            key={artifact}
            search={search}
            path={archivedArtifactPath(archive.anchor, artifact)}
          >
            {ARTIFACT_LABELS[artifact] ?? artifact}
          </VaultLink>
        ))}
        {capabilities.map((capability) => (
          <VaultLink
            key={capability}
            search={search}
            path={archivedArtifactPath(archive.anchor, `specs/${capability}/spec.md`)}
          >
            {capabilities.length > 1 ? `${capability} delta` : "delta spec"}
          </VaultLink>
        ))}
      </span>
    </li>
  );
}

function ArchiveList({
  archives,
  capabilities,
  search,
  empty,
}: {
  archives: StudioGraphArchive[];
  capabilities: string[];
  search: StudioSearch;
  empty: string;
}) {
  if (archives.length === 0) return <p className="m-0 text-sm text-muted">{empty}</p>;
  return (
    <ul className="m-0 list-none p-0">
      {archives.map((archive) => (
        <ArchiveRow
          key={archive.anchor}
          archive={archive}
          capabilities={capabilities}
          search={search}
        />
      ))}
    </ul>
  );
}

function NodeList({
  nodes,
  onSelectNode,
}: {
  nodes: StudioGraphNode[];
  onSelectNode: (id: string) => void;
}) {
  return (
    <ul className="m-0 grid list-none gap-0.5 p-0">
      {nodes.map((node) => (
        <li key={node.id}>
          <button
            type="button"
            className={cn(
              "w-full truncate rounded-[4px] border-0 bg-transparent px-1.5 py-0.5 text-left text-sm text-text hover:bg-surface",
              node.kind === "capability" && "font-mono",
            )}
            data-graph-node={node.id}
            onClick={() => onSelectNode(node.id)}
          >
            {node.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Neighbours of `node` over `kind` edges, sorted by label. */
function linked(
  wire: StudioSpecGraph,
  index: NodeIndex,
  node: number,
  kind: string,
  outgoing?: boolean,
) {
  return index.links[node]
    .flatMap((link) =>
      link.kind === kind && (outgoing === undefined || link.outgoing === outgoing)
        ? [wire.nodes[link.other]]
        : [],
    )
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

function CapabilityPanel({
  wire,
  index,
  search,
  onSelectNode,
  node,
}: PanelProps & { node: number }) {
  const capability = capabilityOf(wire.nodes[node]);
  const areas = linked(wire, index, node, "binds", true).map((area) => area.area ?? area.label);
  const history = wire.history[node].map((archive) => wire.archives[archive]);
  const mentions = linked(wire, index, node, "mentions", true);
  const mentionedBy = linked(wire, index, node, "mentions", false);
  const coChanged = linked(wire, index, node, "co-change");
  return (
    <SpecDetail spec={{ capability, areas }} companion={search.companion} withStatus={false}>
      <PanelSection title="History" aside={`${history.length} archived`}>
        <ArchiveList
          archives={history}
          capabilities={[capability]}
          search={search}
          empty="No archived change names this spec."
        />
      </PanelSection>
      {mentions.length + mentionedBy.length + coChanged.length > 0 ? (
        <PanelSection title="Connected specs">
          {mentions.length > 0 ? (
            <Group label="Mentions" nodes={mentions} onSelectNode={onSelectNode} />
          ) : null}
          {mentionedBy.length > 0 ? (
            <Group label="Mentioned by" nodes={mentionedBy} onSelectNode={onSelectNode} />
          ) : null}
          {coChanged.length > 0 ? (
            <Group label="Changed together" nodes={coChanged} onSelectNode={onSelectNode} />
          ) : null}
        </PanelSection>
      ) : null}
    </SpecDetail>
  );
}

function Group({
  label,
  nodes,
  onSelectNode,
}: {
  label: string;
  nodes: StudioGraphNode[];
  onSelectNode: (id: string) => void;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted">{label}</span>
      <NodeList nodes={nodes} onSelectNode={onSelectNode} />
    </div>
  );
}

function AreaPanel({ wire, index, onSelectNode, node }: PanelProps & { node: number }) {
  const area = wire.nodes[node];
  const capabilities = linked(wire, index, node, "binds", false);
  const repository = linked(wire, index, node, "in", true)[0];
  return (
    <>
      <PanelHead
        mono={area.area !== "."}
        title={area.label}
        kicker={
          <>
            <span>Area</span>
            {repository ? (
              <button
                type="button"
                className="ml-auto border-0 bg-transparent p-0 font-mono text-xs text-muted hover:text-text"
                onClick={() => onSelectNode(repository.id)}
              >
                {repository.label}
              </button>
            ) : null}
          </>
        }
      />
      <PanelSection title="Capabilities" aside={capabilities.length}>
        <NodeList nodes={capabilities} onSelectNode={onSelectNode} />
      </PanelSection>
    </>
  );
}

function RepositoryPanel({ wire, index, onSelectNode, node }: PanelProps & { node: number }) {
  const repository = wire.nodes[node];
  const areas = linked(wire, index, node, "in", false);
  return (
    <>
      <PanelHead mono title={repository.label} kicker={<span>Repository</span>} />
      {areas.map((area) => {
        const areaIndex = index.byId.get(area.id)!;
        const capabilities = linked(wire, index, areaIndex, "binds", false);
        return (
          <PanelSection
            key={area.id}
            title={area.area === "." ? ROOT_AREA_LABEL : area.label}
            aside={capabilities.length}
          >
            <button
              type="button"
              className="justify-self-start border-0 bg-transparent p-0 text-xs text-muted hover:text-text"
              onClick={() => onSelectNode(area.id)}
            >
              Open Area
            </button>
            <NodeList nodes={capabilities} onSelectNode={onSelectNode} />
          </PanelSection>
        );
      })}
    </>
  );
}

const EDGE_TITLES = {
  binds: "Binds",
  in: "In repository",
  mentions: "Mentions",
  "co-change": "Changed together",
} as const;

function EdgePanel({
  wire,
  search,
  onSelectNode,
  edge,
}: Omit<PanelProps, "index"> & { edge: number }) {
  const found = edgeAt(wire, edge);
  if (!found)
    return (
      <p className="m-0 px-5 py-4 text-sm text-muted">This connection is no longer in the graph.</p>
    );
  const source = wire.nodes[found.source];
  const target = wire.nodes[found.target];
  const archives =
    found.kind === "co-change" ? sharedArchives(wire, found.source, found.target) : [];
  return (
    <>
      <PanelHead
        title={EDGE_TITLES[found.kind]}
        kicker={
          found.kind === "co-change" ? (
            <span>{`${found.weight} shared archived ${found.weight === 1 ? "change" : "changes"}`}</span>
          ) : null
        }
      >
        <span className="flex flex-wrap items-center gap-1.5 font-mono text-sm">
          <button
            type="button"
            className="border-0 bg-transparent p-0 text-accent"
            onClick={() => onSelectNode(source.id)}
          >
            {source.label}
          </button>
          <span className="text-muted" aria-hidden="true">
            {found.kind === "co-change" ? "↔" : "→"}
          </span>
          <button
            type="button"
            className="border-0 bg-transparent p-0 text-accent"
            onClick={() => onSelectNode(target.id)}
          >
            {target.label}
          </button>
        </span>
      </PanelHead>
      {found.kind === "co-change" ? (
        <PanelSection title="Archived changes" aside={archives.length}>
          <ArchiveList
            archives={archives}
            capabilities={[source.label, target.label]}
            search={search}
            empty="No archive names both specs."
          />
        </PanelSection>
      ) : null}
    </>
  );
}

/** The panel body for a selection; `null` when the selection names nothing in the graph. */
export function GraphPanelBody({
  selection,
  ...props
}: PanelProps & { selection: GraphSelection }) {
  if ("edge" in selection) return <EdgePanel {...props} edge={selection.edge} />;
  const node = props.index.byId.get(selection.node);
  if (node === undefined) return null;
  const kind = props.wire.nodes[node].kind;
  if (kind === "capability") return <CapabilityPanel {...props} node={node} />;
  if (kind === "area") return <AreaPanel {...props} node={node} />;
  return <RepositoryPanel {...props} node={node} />;
}
