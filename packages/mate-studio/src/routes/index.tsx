import { createFileRoute } from "@tanstack/react-router";

import { loadView, registeredCompanion } from "../lib/queries";
import { companionViewQuery } from "../lib/studio-queries";
import { CompanionView } from "../shell/companion-view";
import { AnalystOverview } from "../views/overview/analyst-overview";
import { Dashboard } from "../views/overview/dashboard";

export const Route = createFileRoute("/")({
  staticData: { view: "dashboard" },
  // The open change's panel; a reload opens it again. Matched against listed names only.
  validateSearch: (raw: { change?: unknown }): { change?: string } =>
    typeof raw.change === "string" && raw.change !== "" ? { change: raw.change } : {},
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  // Drawn with the document, so a direct open shows the view, not its placeholder.
  ssr: true,
  loader: async ({ context, deps }) =>
    (await registeredCompanion(context.queryClient, deps))
      ? loadView(context.queryClient, companionViewQuery("dashboard", deps))
      : null,
  component: Overview,
});

/** Each mode reads its own Overview; the server's effective mode picks it, not the address. */
function Overview() {
  const search = Route.useSearch();
  return (
    <CompanionView view="dashboard" search={search}>
      {(data) =>
        data.studioMode === "analysis" ? (
          <AnalystOverview payload={{ shipped: data.shipped ?? [], warnings: data.warnings }} />
        ) : (
          <Dashboard
            payload={{ changes: data.changes ?? [], warnings: data.warnings }}
            selected={search.change}
            companion={search.companion}
          />
        )
      }
    </CompanionView>
  );
}
