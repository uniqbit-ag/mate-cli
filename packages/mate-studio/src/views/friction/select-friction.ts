import {
  selectByState,
  SUBJECT_TYPES,
  subjectTypeOf,
  type FrictionFreeReport,
  type FrictionView,
  type FrictionViewGroup,
  type ReportKind,
  type StateFilter,
  type SubjectType,
} from "@uniqbit/mate-core/studio";

import type { FrictionSort, StudioSearch } from "../../lib/search";

/** As the address carries them; an absent type or kind means All. */
export interface FrictionFilters {
  state: StateFilter;
  type?: SubjectType;
  kind?: ReportKind;
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

export interface FrictionShown {
  groups: FrictionViewGroup[];
  freeReports: FrictionFreeReport[];
  /** Items of the period the filters leave out. */
  hidden: number;
  /** The subject types present in the period, in vocabulary order. */
  types: SubjectType[];
  /** The type filtered on; a type absent from the period reads as All. */
  type?: SubjectType;
}

export function selectFriction(view: FrictionView, filters: FrictionFilters): FrictionShown {
  const reportTypes = new Map(
    view.freeReports.map((report) => [report.id, subjectTypeOf(report.subject)]),
  );
  const present = new Set([
    ...view.groups.map((group) => group.subjectType),
    ...reportTypes.values(),
  ]);
  const types = SUBJECT_TYPES.filter((type) => present.has(type));
  const type = types.find((known) => known === filters.type);
  const byState = selectByState(view, filters.state);
  const groups = byState.groups.filter((group) => !type || group.subjectType === type);
  const freeReports = byState.freeReports.filter(
    (report) =>
      (!type || reportTypes.get(report.id) === type) &&
      (!filters.kind || report.kind === filters.kind),
  );
  const total = view.groups.length + view.freeReports.length;
  return {
    // Most repeated is the summary's own order.
    groups:
      filters.sort === "recent"
        ? groups.toSorted((a, b) =>
            a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0,
          )
        : groups,
    freeReports,
    hidden: total - groups.length - freeReports.length,
    types,
    type,
  };
}
