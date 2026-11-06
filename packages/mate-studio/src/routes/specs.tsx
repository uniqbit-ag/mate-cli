import { createFileRoute } from "@tanstack/react-router";

import { loadView, registeredCompanion } from "../lib/queries";
import { validateSpecsSearch } from "../lib/search";
import { companionViewQuery } from "../lib/studio-queries";
import { specOffers } from "../lib/spec-offers";
import { CompanionView } from "../shell/companion-view";
import { Specs } from "../views/specs/specs-view";

export const Route = createFileRoute("/specs")({
  staticData: { view: "specs" },
  validateSearch: validateSpecsSearch,
  // Search and filters narrow loaded data; they never refetch it.
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  ssr: true,
  loader: async ({ context, deps }) =>
    (await registeredCompanion(context.queryClient, deps))
      ? loadView(context.queryClient, companionViewQuery("specs", deps))
      : null,
  component: function SpecsRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <CompanionView view="specs" search={search}>
        {(data) => (
          <Specs
            payload={{ specs: data.specs ?? [], warnings: data.warnings }}
            actions={specOffers(data)}
            companion={search.companion}
            filter={{ q: search.q, repo: search.repo, area: search.area }}
            onFilterChange={(next) =>
              void navigate({
                search: (previous) => ({
                  ...previous,
                  q: next.q || undefined,
                  repo: next.repo,
                  area: next.area,
                }),
                replace: true,
              })
            }
          />
        )}
      </CompanionView>
    );
  },
});
