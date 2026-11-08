import { createFileRoute } from "@tanstack/react-router";

import { registeredCompanion } from "../lib/queries";
import { Usage } from "../views/usage/usage-view";

export const Route = createFileRoute("/usage")({
  staticData: { view: "usage" },
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  loader: ({ context, deps }) => registeredCompanion(context.queryClient, deps),
  component: function UsageRoute() {
    const search = Route.useSearch();
    return search.companion ? (
      <Usage key={`${search.companion}:${search.usageDays ?? 7}`} search={search} />
    ) : null;
  },
});
