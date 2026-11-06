/**
 * The spec graph's wire model, shared by Core's index and Studio's view. No Node imports:
 * Studio's browser bundle imports it.
 */

export type StudioGraphNodeKind = "capability" | "area" | "repository";

/** Edge kinds by wire code: an edge's kind is its index here. */
export const GRAPH_EDGE_KINDS = ["binds", "in", "mentions", "co-change"] as const;
export type StudioGraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

/** Values per edge in `StudioSpecGraph.edges`: source, target, kind code, weight. */
export const GRAPH_EDGE_STRIDE = 4;

/** Archive artifacts the panel links, besides the capability's own delta spec. */
export const GRAPH_ARTIFACTS = ["proposal.md", "design.md", "tasks.md", "verification.md"] as const;

export interface StudioGraphNode {
  kind: StudioGraphNodeKind;
  /** `spec:<capability>`, `area:<repository>#<area>`, or `repo:<repository>`. */
  id: string;
  label: string;
  /** Area nodes: the pair that identifies them. */
  repository?: string;
  area?: string;
}

export interface StudioGraphArchive {
  /** Dated directory name, e.g. `2026-09-07-acme`. */
  anchor: string;
  name: string;
  archivedOn: string;
  /** Which of `GRAPH_ARTIFACTS` exist in the archive. */
  artifacts: string[];
}

export interface StudioSpecGraph {
  nodes: StudioGraphNode[];
  /** Flat `[source, target, kind, weight, …]`; source and target index `nodes`. */
  edges: number[];
  /** Dated archives that name at least one canonical capability, newest first. */
  archives: StudioGraphArchive[];
  /** Per node, indices into `archives` naming it, newest first; empty for non-capabilities. */
  history: number[][];
  /** Capabilities whose frontmatter names no repository or no Area. */
  unbound: string[];
  /** Explicit spec links that resolve to no capability. */
  broken: { from: string; target: string }[];
}

export const ROOT_AREA_LABEL = "Repository root";

export const capabilityNodeId = (capability: string) => `spec:${capability}`;
export const areaNodeId = (repository: string, area: string) => `area:${repository}#${area}`;
export const repositoryNodeId = (repository: string) => `repo:${repository}`;

/** Companion-relative path of an archived artifact; `specs/<capability>/spec.md` for a delta. */
export const archivedArtifactPath = (anchor: string, artifact: string) =>
  `openspec/changes/archive/${anchor}/${artifact}`;

export const canonicalSpecPath = (capability: string) => `openspec/specs/${capability}/spec.md`;
