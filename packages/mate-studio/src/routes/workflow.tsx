import { createFileRoute } from "@tanstack/react-router";

import { loadView, registeredCompanion } from "../lib/queries";
import { companionViewQuery } from "../lib/studio-queries";
import { CompanionView } from "../shell/companion-view";
import { Workflow } from "../views/workflow/workflow-view";

export const Route = createFileRoute("/workflow")({
  staticData: { view: "workflow" },
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  loader: async ({ context, deps }) =>
    (await registeredCompanion(context.queryClient, deps))
      ? loadView(context.queryClient, companionViewQuery("workflow", deps))
      : null,
  component: function WorkflowRoute() {
    const search = Route.useSearch();
    return (
      <CompanionView view="workflow" search={search}>
        {(data) => (
          <Workflow
            payload={{
              skills: data.skills ?? [],
              topology: data.topology ?? null,
              warnings: data.warnings,
            }}
          />
        )}
      </CompanionView>
    );
  },
});
