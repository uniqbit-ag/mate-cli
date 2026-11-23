import {
  SUBJECT_TYPES,
  type ReportKind,
  type StateFilter,
  type SubjectType,
} from "../../../runtime/friction-vocabulary";
import type { FrictionFreeReport, FrictionGroup, FrictionView } from "./model";

export interface FrictionFilters {
  state: StateFilter;
  /** Absent means every type. */
  type?: SubjectType;
  /** Narrows Free Reports only; absent means every kind. */
  kind?: ReportKind;
}

export interface FrictionShown {
  groups: FrictionGroup[];
  freeReports: FrictionFreeReport[];
  /** Items of the period the filters leave out. */
  hidden: number;
  /** The subject types present in the period, in vocabulary order. */
  types: SubjectType[];
  /** The type filtered on; a type absent from the period reads as every type. */
  type?: SubjectType;
}

/** The Friction Items the filters show, in the view's order. */
export function selectFriction(
  view: Pick<FrictionView, "groups" | "freeReports">,
  filters: FrictionFilters,
): FrictionShown {
  const present = new Set<SubjectType | null>([
    ...view.groups.map((group) => group.subjectType),
    ...view.freeReports.map((report) => report.subjectType),
  ]);
  const types = SUBJECT_TYPES.filter((type) => present.has(type));
  const type = types.find((known) => known === filters.type);
  const shown = (item: { open: boolean; subjectType: SubjectType | null }) =>
    (filters.state === "all" || item.open === (filters.state === "open")) &&
    (!type || item.subjectType === type);
  const groups = view.groups.filter(shown);
  const freeReports = view.freeReports.filter(
    (report) => shown(report) && (!filters.kind || report.kind === filters.kind),
  );
  const total = view.groups.length + view.freeReports.length;
  return {
    groups,
    freeReports,
    hidden: total - groups.length - freeReports.length,
    types,
    type,
  };
}
