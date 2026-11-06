import { createFileRoute } from "@tanstack/react-router";

import { GraphView } from "../views/graph/graph-view";

const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 1024 ? value : undefined;

export const Route = createFileRoute("/graph")({
  // Forgiving like the server's parsing: a malformed node selects nothing.
  validateSearch: (raw: { node?: unknown }): { node?: string } =>
    text(raw.node) ? { node: text(raw.node) } : {},
  staticData: { view: "graph" },
  // A canvas only the browser can draw; the frame still renders on the server.
  ssr: false,
  component: function GraphRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    if (!search.companion) return null;
    return (
      <GraphView
        search={{ companion: search.companion, studioMode: search.studioMode }}
        node={search.node}
        onNodeChange={(node) =>
          void navigate({ search: (previous) => ({ ...previous, node }), replace: false })
        }
      />
    );
  },
});
