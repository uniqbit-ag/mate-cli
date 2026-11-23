import {
  selectFriction as selectItems,
  type FrictionFilters as ItemFilters,
  type FrictionShown,
  type FrictionView,
} from "@uniqbit/mate-core/studio";

import type { FrictionSort, StudioSearch } from "../../lib/search";

/** As the address carries them; an absent type or kind means All. */
export interface FrictionFilters extends ItemFilters {
  sort: FrictionSort;
}

export const DEFAULT_FRICTION_FILTERS: FrictionFilters = { state: "open", sort: "repeats" };

export function filtersFromSearch(search: StudioSearch): FrictionFilters {
  return {
    state: search.frictionState ?? DEFAULT_FRICTION_FILTERS.state,
    type: search.frictionType,
    kind: search.frictionKind,
    sort: search.frictionSort ?? DEFAULT_FRICTION_FILTERS.sort,
  };
}

/** Defaults leave the address, so it stays short. */
export function searchFromFilters(
  filters: FrictionFilters,
): Pick<StudioSearch, "frictionState" | "frictionType" | "frictionKind" | "frictionSort"> {
  return {
    frictionState: filters.state === DEFAULT_FRICTION_FILTERS.state ? undefined : filters.state,
    frictionType: filters.type,
    frictionKind: filters.kind,
    frictionSort: filters.sort === DEFAULT_FRICTION_FILTERS.sort ? undefined : filters.sort,
  };
}

/** Core's selection in the chosen order; most repeated is the view's own order. */
export function selectFriction(view: FrictionView, filters: FrictionFilters): FrictionShown {
  const shown = selectItems(view, filters);
  if (filters.sort !== "recent") return shown;
  return {
    ...shown,
    groups: shown.groups.toSorted((a, b) =>
      a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0,
    ),
  };
}
