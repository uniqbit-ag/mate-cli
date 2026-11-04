import { queryOptions } from "@tanstack/react-query";

import type { StudioSearch } from "./search";
import { type CompanionView, getCompanionView } from "../server/views";

export const companionViewQuery = (view: CompanionView, search: StudioSearch) =>
  queryOptions({
    queryKey: [view, search.companion ?? null, search.studioMode ?? null],
    queryFn: () => getCompanionView({ data: { ...search, view } }),
  });
