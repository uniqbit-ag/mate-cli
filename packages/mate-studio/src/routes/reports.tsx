import { createFileRoute } from "@tanstack/react-router";

import { loadView, registeredCompanion } from "../lib/queries";
import { reportsQuery } from "../lib/studio-queries";
import { Reports } from "../views/reports/reports-view";

export const Route = createFileRoute("/reports")({
  staticData: { view: "reports" },
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  loader: async ({ context, deps }) => {
    const companion = await registeredCompanion(context.queryClient, deps);
    return companion ? loadView(context.queryClient, reportsQuery(companion)) : null;
  },
  component: function ReportsRoute() {
    const { companion } = Route.useSearch();
    return companion ? <Reports companion={companion} /> : null;
  },
});
