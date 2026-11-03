import { createFileRoute } from "@tanstack/react-router";

import { registeredCompanion } from "../lib/queries";
import { companionViewQuery } from "../lib/view-query";
import { specOffers } from "../lib/spec-offers";
import { CompanionView } from "../shell/companion-view";
import { Specs } from "../views/specs/specs-view";

export const Route = createFileRoute("/specs")({
  staticData: { view: "specs" },
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  loader: async ({ context, deps }) =>
    (await registeredCompanion(context.queryClient, deps))
      ? context.queryClient.ensureQueryData(companionViewQuery("specs", deps))
      : null,
  component: function SpecsRoute() {
    const search = Route.useSearch();
    return (
      <CompanionView view="specs" search={search}>
        {(data) => (
          <Specs
            payload={{ specs: data.specs ?? [], warnings: data.warnings }}
            actions={specOffers(data)}
          />
        )}
      </CompanionView>
    );
  },
});
