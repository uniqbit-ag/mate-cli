import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { loadView, registeredCompanion } from "../lib/queries";
import { workQuery } from "../lib/studio-queries";
import { validateWorkSearch, type WorkSearch } from "../views/work/work-search";
import { Work } from "../views/work/work-view";

export const Route = createFileRoute("/work")({
  staticData: { view: "work" },
  validateSearch: (raw: Record<string, unknown>): WorkSearch => validateWorkSearch(raw),
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  loader: async ({ context, deps }) => {
    const companion = await registeredCompanion(context.queryClient, deps);
    return companion ? loadView(context.queryClient, workQuery(companion)) : null;
  },
  component: WorkRoute,
});

function WorkRoute() {
  const search = Route.useSearch();
  if (!search.companion) return null;
  return <WorkBoard search={search} />;
}

function WorkBoard({ search }: { search: WorkSearch }) {
  const { data } = useSuspenseQuery(workQuery(search.companion!));
  return <Work payload={data} search={search} />;
}
