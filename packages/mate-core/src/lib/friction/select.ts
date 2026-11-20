import type { StateFilter } from "../../runtime/friction-vocabulary";

interface Item {
  open: boolean;
}

export interface FrictionSelection<G extends Item, R extends Item> {
  groups: G[];
  freeReports: R[];
  /** Items the filter leaves out. */
  hidden: number;
}

/** The groups and Free Reports a state filter shows, in their order; free of node imports. */
export function selectByState<G extends Item, R extends Item>(
  summary: { groups: G[]; freeReports: R[] },
  filter: StateFilter,
): FrictionSelection<G, R> {
  const shown = (item: Item) => filter === "all" || item.open === (filter === "open");
  const groups = summary.groups.filter(shown);
  const freeReports = summary.freeReports.filter(shown);
  const total = summary.groups.length + summary.freeReports.length;
  return { groups, freeReports, hidden: total - groups.length - freeReports.length };
}
