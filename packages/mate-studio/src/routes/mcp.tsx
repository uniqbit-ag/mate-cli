import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { mcpManagerQuery } from "../lib/mcp-query";
import { loadView, registeredCompanion } from "../lib/queries";
import { shellQuery } from "../lib/studio-queries";
import { Mcp } from "../views/mcp/mcp-view";

export const Route = createFileRoute("/mcp")({
  staticData: { view: "mcp" },
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  ssr: true,
  loader: async ({ context, deps }) => {
    const companion = await registeredCompanion(context.queryClient, deps);
    if (!companion) return null;
    // An unreadable framework.yaml is the view's to report, with its Retry.
    return loadView(context.queryClient, mcpManagerQuery(companion)).catch(() => null);
  },
  component: function McpRoute() {
    const search = Route.useSearch();
    const { data: shell } = useSuspenseQuery(
      shellQuery({ companion: search.companion, studioMode: search.studioMode }),
    );
    if (!search.companion || !shell.selected) return null;
    return <Mcp key={search.companion} companion={search.companion} writable={shell.writable} />;
  },
});
