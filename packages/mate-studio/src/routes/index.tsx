import { createFileRoute } from "@tanstack/react-router";

import { registeredCompanion } from "../lib/queries";
import { companionViewQuery } from "../lib/view-query";
import { CompanionView } from "../shell/companion-view";
import { AnalystOverview } from "../views/overview/analyst-overview";
import { Dashboard } from "../views/overview/dashboard";

export const Route = createFileRoute("/")({
  staticData: { view: "dashboard" },
  loaderDeps: ({ search }) => ({ companion: search.companion, role: search.role }),
  loader: async ({ context, deps }) =>
    (await registeredCompanion(context.queryClient, deps))
      ? context.queryClient.ensureQueryData(companionViewQuery("dashboard", deps))
      : null,
  component: Overview,
});

/** Each role reads its own Overview. */
function Overview() {
  const search = Route.useSearch();
  return (
    <CompanionView view="dashboard" search={search}>
      {(data) =>
        search.role === "business-analyst" ? (
          <AnalystOverview
            payload={{
              specs: data.specs ?? [],
              shipped: data.shipped ?? [],
              warnings: data.warnings,
            }}
            reports={data.reports}
          />
        ) : (
          <Dashboard payload={{ changes: data.changes ?? [], warnings: data.warnings }} />
        )
      }
    </CompanionView>
  );
}
