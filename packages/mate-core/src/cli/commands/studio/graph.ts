import fs from "node:fs/promises";
import path from "node:path";

import {
  archiveAnchors,
  archiveDirOf,
  deltaSpecs,
  filesBelow,
  parseAnchor,
  SPECS_RELATIVE_DIR,
} from "../../../lib/change-layout";
import { readFrontmatter } from "../../../lib/frontmatter";
import {
  areaNodeId,
  capabilityNodeId,
  GRAPH_ARTIFACTS,
  GRAPH_EDGE_KINDS,
  repositoryNodeId,
  ROOT_AREA_LABEL,
  type StudioGraphArchive,
  type StudioGraphEdgeKind,
  type StudioGraphNode,
  type StudioSpecGraph,
} from "./graph-model";

export * from "./graph-model";

/**
 * The Library's spec graph: capabilities, the repository/Area pairs they bind, and their
 * repositories, linked by frontmatter binding, explicit mentions, and shared archives.
 * Canonical spec contents are read; archives contribute directory and entry names only.
 */

export interface GraphSpecSource {
  capability: string;
  content: string;
}

export interface GraphArchiveSource {
  anchor: string;
  /** Capabilities its delta specs name. */
  capabilities: string[];
  /** Entry names directly in the archive directory. */
  entries: string[];
}

const WIKI_SPEC_LINK = /\[\[(?:[^\]|#]*?\/)?specs\/([^\]|#]+?)\/spec(?:\.md)?(?:[#|][^\]]*)?\]\]/g;
const MARKDOWN_SPEC_LINK = /\]\(<?([^)\s>]*?spec\.md)(?:#[^)\s>]*)?>?(?:\s+"[^"]*")?\)/g;
const BACKTICKED = /`([A-Za-z0-9][A-Za-z0-9._/-]*)`/g;
const SPECS_SUFFIX = /(?:^|\/)specs\/(.+)\/spec\.md$/;

function scopeOf(content: string): { repository: string | null; areas: string[] } {
  const frontmatter = readFrontmatter(content);
  const repository =
    typeof frontmatter?.repository === "string" && frontmatter.repository.trim()
      ? frontmatter.repository.trim()
      : null;
  const areas = Array.isArray(frontmatter?.areas)
    ? frontmatter.areas
        .filter((area): area is string => typeof area === "string")
        .map((area) => area.trim())
        .filter(Boolean)
    : [];
  return { repository, areas: [...new Set(areas)] };
}

/** The capability a relative markdown link from `capability`'s spec names; null when none. */
function linkedCapability(capability: string, target: string): string | null {
  const from = `${SPECS_RELATIVE_DIR}/${capability}`;
  const resolved = path.posix.normalize(path.posix.join(from, decodeURI(target)));
  const prefix = `${SPECS_RELATIVE_DIR}/`;
  if (resolved.startsWith(prefix) && resolved.endsWith("/spec.md")) {
    return resolved.slice(prefix.length, -"/spec.md".length) || null;
  }
  return SPECS_SUFFIX.exec(target)?.[1] ?? null;
}

interface Mentions {
  targets: Set<string>;
  broken: Set<string>;
}

/** Explicit links and backticked ids in one spec, resolved against `known`. */
function resolveMentions(
  capability: string,
  content: string,
  known: ReadonlySet<string>,
): Mentions {
  const targets = new Set<string>();
  const broken = new Set<string>();
  const explicit = (target: string | null) => {
    if (!target || target === capability) return;
    if (known.has(target)) targets.add(target);
    else broken.add(target);
  };
  for (const match of content.matchAll(WIKI_SPEC_LINK)) explicit(match[1].trim());
  for (const match of content.matchAll(MARKDOWN_SPEC_LINK)) {
    try {
      explicit(linkedCapability(capability, match[1]));
    } catch {
      // Malformed percent-encoding; not a resolvable link.
    }
  }
  for (const match of content.matchAll(BACKTICKED)) {
    const target = match[1];
    if (target !== capability && known.has(target)) targets.add(target);
  }
  return { targets, broken };
}

/** The graph for already-read sources; pure, so it is tested without a companion. */
export function deriveSpecGraph(
  specs: readonly GraphSpecSource[],
  archives: readonly GraphArchiveSource[],
): StudioSpecGraph {
  const nodes: StudioGraphNode[] = [];
  const indexOf = new Map<string, number>();
  const node = (entry: StudioGraphNode): number => {
    const existing = indexOf.get(entry.id);
    if (existing !== undefined) return existing;
    indexOf.set(entry.id, nodes.length);
    nodes.push(entry);
    return nodes.length - 1;
  };

  const sorted = specs.toSorted((a, b) => a.capability.localeCompare(b.capability));
  const known = new Set(sorted.map((spec) => spec.capability));
  for (const spec of sorted) {
    node({ kind: "capability", id: capabilityNodeId(spec.capability), label: spec.capability });
  }

  const edges: number[] = [];
  const edge = (source: number, target: number, kind: StudioGraphEdgeKind, weight = 1) => {
    edges.push(source, target, GRAPH_EDGE_KINDS.indexOf(kind), weight);
  };

  const unbound: string[] = [];
  const broken: StudioSpecGraph["broken"] = [];
  const linkedAreas = new Set<number>();
  for (const spec of sorted) {
    const source = indexOf.get(capabilityNodeId(spec.capability))!;
    const { repository, areas } = scopeOf(spec.content);
    if (!repository || areas.length === 0) {
      unbound.push(spec.capability);
    } else {
      const repositoryIndex = node({
        kind: "repository",
        id: repositoryNodeId(repository),
        label: repository,
      });
      for (const area of areas) {
        const areaIndex = node({
          kind: "area",
          id: areaNodeId(repository, area),
          label: area === "." ? ROOT_AREA_LABEL : area,
          repository,
          area,
        });
        edge(source, areaIndex, "binds");
        if (!linkedAreas.has(areaIndex)) {
          linkedAreas.add(areaIndex);
          edge(areaIndex, repositoryIndex, "in");
        }
      }
    }
    const mentions = resolveMentions(spec.capability, spec.content, known);
    for (const target of [...mentions.targets].toSorted()) {
      edge(source, indexOf.get(capabilityNodeId(target))!, "mentions");
    }
    for (const target of [...mentions.broken].toSorted()) {
      broken.push({ from: spec.capability, target });
    }
  }

  const dated = archives
    .flatMap((archive) => {
      const anchor = parseAnchor(archive.anchor);
      const capabilities = [...new Set(archive.capabilities)].filter((id) => known.has(id));
      return anchor && capabilities.length > 0
        ? [{ ...archive, parsed: anchor, capabilities }]
        : [];
    })
    // Dated anchors sort newest first in code-unit order.
    .toSorted((a, b) => (a.anchor === b.anchor ? 0 : a.anchor < b.anchor ? 1 : -1));

  const history: number[][] = nodes.map(() => []);
  const weights = new Map<string, number>();
  const graphArchives: StudioGraphArchive[] = dated.map((archive, archiveIndex) => {
    const members = archive.capabilities
      .map((capability) => indexOf.get(capabilityNodeId(capability))!)
      .toSorted((a, b) => a - b);
    for (const member of members) history[member].push(archiveIndex);
    for (let left = 0; left < members.length; left++) {
      for (let right = left + 1; right < members.length; right++) {
        const key = `${members[left]}:${members[right]}`;
        weights.set(key, (weights.get(key) ?? 0) + 1);
      }
    }
    return {
      anchor: archive.anchor,
      name: archive.parsed.name,
      archivedOn: archive.parsed.date,
      artifacts: GRAPH_ARTIFACTS.filter((artifact) => archive.entries.includes(artifact)),
    };
  });
  for (const [key, weight] of weights) {
    const [source, target] = key.split(":").map(Number);
    edge(source, target, "co-change", weight);
  }

  return { nodes, edges, archives: graphArchives, history, unbound, broken };
}

/** Canonical specs with their contents, and dated archives by entry names. */
async function readSpecGraphSources(companionPath: string): Promise<{
  specs: GraphSpecSource[];
  archives: GraphArchiveSource[];
}> {
  const specsDir = path.join(companionPath, ...SPECS_RELATIVE_DIR.split("/"));
  const specFiles = (await filesBelow(specsDir)).filter(
    (file) => path.posix.basename(file) === "spec.md" && path.posix.dirname(file) !== ".",
  );
  const archiveDir = archiveDirOf(companionPath);
  const [specs, archives] = await Promise.all([
    Promise.all(
      specFiles.map(async (file) => ({
        capability: path.posix.dirname(file),
        content: await fs.readFile(path.join(specsDir, ...file.split("/")), "utf8").catch(() => ""),
      })),
    ),
    archiveAnchors(companionPath).then((anchors) =>
      Promise.all(
        anchors.map(async (anchor) => {
          const dir = path.join(archiveDir, anchor);
          const [deltas, entries] = await Promise.all([
            deltaSpecs(dir),
            fs.readdir(dir).catch((): string[] => []),
          ]);
          return {
            anchor,
            capabilities: deltas.flatMap((delta) => (delta.capability ? [delta.capability] : [])),
            entries,
          };
        }),
      ),
    ),
  ]);
  return { specs, archives };
}

export async function buildSpecGraph(companionPath: string): Promise<StudioSpecGraph> {
  const { specs, archives } = await readSpecGraphSources(companionPath);
  return deriveSpecGraph(specs, archives);
}

export interface SpecGraphCache {
  /**
   * The companion's graph, built once per `basis`: when its collected state was collected,
   * so refreshing that state also rebuilds the graph.
   */
  read(companionPath: string, basis: number | null): Promise<StudioSpecGraph>;
}

/** Holds one graph per companion; reads for the same basis share one build. */
export function createSpecGraphCache(
  build: (companionPath: string) => Promise<StudioSpecGraph> = buildSpecGraph,
): SpecGraphCache {
  const held = new Map<string, { basis: number | null; graph: Promise<StudioSpecGraph> }>();
  return {
    read(companionPath, basis) {
      const entry = held.get(companionPath);
      if (entry && entry.basis === basis) return entry.graph;
      const graph = build(companionPath);
      held.set(companionPath, { basis, graph });
      // A failed build is not held, so the next read tries again.
      graph.catch(() => {
        if (held.get(companionPath)?.graph === graph) held.delete(companionPath);
      });
      return graph;
    },
  };
}
