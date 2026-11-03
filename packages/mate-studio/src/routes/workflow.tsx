import { createFileRoute } from "@tanstack/react-router";

import { registeredCompanion } from "../lib/queries";
import { companionViewQuery } from "../lib/view-query";
import { CompanionView } from "../shell/companion-view";
import { Workflow } from "../views/workflow/workflow-view";

export const Route = createFileRoute("/workflow")({
  staticData: { view: "workflow" },
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  loader: async ({ context, deps }) =>
    (await registeredCompanion(context.queryClient, deps))
      ? context.queryClient.ensureQueryData(companionViewQuery("workflow", deps))
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
