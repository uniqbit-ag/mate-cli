import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { loadView, registeredCompanion } from "../lib/queries";
import { useBrowser } from "../lib/use-browser";
import { companionViewQuery } from "../lib/studio-queries";
import { CompanionView } from "../shell/companion-view";
import { Workflow } from "../views/workflow/workflow-view";

export const Route = createFileRoute("/workflow")({
  staticData: { view: "workflow" },
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  ssr: true,
  loader: async ({ context, deps }) =>
    (await registeredCompanion(context.queryClient, deps))
      ? loadView(context.queryClient, companionViewQuery("workflow", deps))
      : null,
  component: function WorkflowRoute() {
    const search = Route.useSearch();
    // The Overview's changes place counts on the graph; the graph renders without them meanwhile.
    // Browser only, so the server-rendered graph does not wait for another view's data.
    const browser = useBrowser();
    const overview = useQuery({ ...companionViewQuery("dashboard", search), enabled: browser });
    return (
      <CompanionView view="workflow" search={search}>
        {(data) => (
          <Workflow
            payload={{
              skills: data.skills ?? [],
              topology: data.topology ?? null,
              warnings: data.warnings,
            }}
            changes={overview.data?.changes ?? []}
          />
        )}
      </CompanionView>
    );
  },
});
