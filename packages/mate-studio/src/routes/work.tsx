import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { loadHeld, loadView, registeredCompanion } from "../lib/queries";
import { shellQuery, workQuery } from "../lib/studio-queries";
import { validateWorkSearch, type WorkSearch } from "../views/work/work-search";
import { Work } from "../views/work/work-view";

export const Route = createFileRoute("/work")({
  staticData: { view: "work" },
  validateSearch: (raw: Record<string, unknown>): WorkSearch => validateWorkSearch(raw),
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  beforeLoad: async ({ context, search }) => {
    const studioSearch = { companion: search.companion, studioMode: search.studioMode };
    const shell = await loadHeld(context.queryClient, shellQuery(studioSearch));
    return { factoryMode: shell.factoryMode };
  },
  loader: async ({ context, deps }) => {
    const companion = await registeredCompanion(context.queryClient, deps);
    return companion ? loadView(context.queryClient, workQuery(companion)) : null;
  },
  component: WorkRoute,
});

function WorkRoute() {
  const search = Route.useSearch();
  const { factoryMode } = Route.useRouteContext();
  if (!search.companion) return null;
  return <WorkBoard search={search} factoryMode={factoryMode} />;
}

function WorkBoard({ search, factoryMode }: { search: WorkSearch; factoryMode: boolean }) {
  const { data } = useSuspenseQuery(workQuery(search.companion!));
  return <Work payload={data} search={search} factoryMode={factoryMode} />;
}
