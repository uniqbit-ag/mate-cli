import { GRAPH_EDGE_KINDS, type StudioSpecGraph } from "@uniqbit/mate-core/studio";

/** Test data shared by the Graph view's tests. */

const code = (kind: (typeof GRAPH_EDGE_KINDS)[number]) => GRAPH_EDGE_KINDS.indexOf(kind);

/** Two capabilities in one Area of one repository, linked by a mention and two archives. */
export function fixture(): StudioSpecGraph {
  return {
    nodes: [
      { kind: "capability", id: "spec:acme-auth", label: "acme-auth" },
      { kind: "capability", id: "spec:acme-session", label: "acme-session" },
      { kind: "capability", id: "spec:acme-loose", label: "acme-loose" },
      { kind: "repository", id: "repo:acme/web", label: "acme/web" },
      {
        kind: "area",
        id: "area:acme/web#packages/acme",
        label: "packages/acme",
        repository: "acme/web",
        area: "packages/acme",
      },
    ],
    // Flat source, target, kind, weight per edge.
    // prettier-ignore
    edges: [
      0, 4, code("binds"), 1,
      4, 3, code("in"), 1,
      1, 4, code("binds"), 1,
      0, 1, code("mentions"), 1,
      0, 1, code("co-change"), 2,
      1, 2, code("co-change"), 1,
    ],
    archives: [
      { anchor: "2026-03-01-new", name: "new", archivedOn: "2026-03-01", artifacts: ["tasks.md"] },
      { anchor: "2026-02-01-mid", name: "mid", archivedOn: "2026-02-01", artifacts: ["tasks.md"] },
      {
        anchor: "2026-01-01-old",
        name: "old",
        archivedOn: "2026-01-01",
        artifacts: ["proposal.md", "tasks.md"],
      },
    ],
    history: [[0, 2], [0, 1, 2], [1], [], []],
    unbound: ["acme-loose"],
    broken: [],
  };
}
