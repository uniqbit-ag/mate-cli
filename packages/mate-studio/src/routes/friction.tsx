import { createFileRoute } from "@tanstack/react-router";

import { DEFAULT_FRICTION_DAYS } from "../lib/friction-query";
import { registeredCompanion } from "../lib/queries";
import { Friction } from "../views/friction/friction-view";
import { filtersFromSearch, searchFromFilters } from "../views/friction/select-friction";

export const Route = createFileRoute("/friction")({
  staticData: { view: "friction" },
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  loader: ({ context, deps }) => registeredCompanion(context.queryClient, deps),
  component: function FrictionRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return search.companion ? (
      <Friction
        key={search.companion}
        companion={search.companion}
        days={search.frictionDays ?? DEFAULT_FRICTION_DAYS}
        onDays={(frictionDays) =>
          void navigate({ search: (previous) => ({ ...previous, frictionDays }) })
        }
        filters={filtersFromSearch(search)}
        onFilters={(filters) =>
          void navigate({ search: (previous) => ({ ...previous, ...searchFromFilters(filters) }) })
        }
      />
    ) : null;
  },
});
