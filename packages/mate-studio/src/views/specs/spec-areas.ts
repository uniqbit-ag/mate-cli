import type { StudioSpec } from "@uniqbit/mate-core/studio";

import type { SpecsSearch } from "../../lib/search";

/**
 * The address value of the No repository filter. Parentheses appear in no `org/repository`
 * identity or registry ID, so a spec naming a repository `none` stays its own group.
 */
export const NO_REPOSITORY = "(none)";
const UNASSIGNED_AREA = "unassigned";

/** Search and filters as the address carries them; absent means All. */
export type SpecFilter = SpecsSearch;

/** One repository/Area place a spec is listed under. */
interface Placement {
  /** `null` for specs and pairs without a repository. */
  repository: string | null;
  area: string;
  spec: StudioSpec;
}

export interface SpecAreaGroup {
  area: string;
  specs: StudioSpec[];
}

export interface SpecRepositoryGroup {
  repository: string | null;
  areas: SpecAreaGroup[];
}

export interface RepositoryOption {
  /** The address value: the repository, or {@link NO_REPOSITORY}. */
  value: string;
  repository: string | null;
  count: number;
}

export interface SpecFilterOptions {
  repositories: RepositoryOption[];
  areas: AreaOption[];
}

export interface AreaOption {
  /** The repository's address value; picking the Area under All repositories selects it too. */
  repo: string;
  repository: string | null;
  area: string;
  count: number;
}

const repoValue = (repository: string | null): string => repository ?? NO_REPOSITORY;

/** A spec binds one pair or several, so it is placed under each of them. */
function placements(specs: StudioSpec[]): Placement[] {
  return specs.flatMap((spec) =>
    spec.scopes.length === 0
      ? [{ repository: null, area: UNASSIGNED_AREA, spec }]
      : spec.scopes.map((scope) => ({
          repository: scope.repository ?? null,
          area: scope.area ?? UNASSIGNED_AREA,
          spec,
        })),
  );
}

/** Repositories by name, No repository last. */
function compareRepositories(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}

const countSpecs = (entries: Placement[]): number =>
  new Set(entries.map((entry) => entry.spec.capability)).size;

/** Repository options, then the chosen repository's Area options, each with its spec count. */
export function filterOptions(specs: StudioSpec[], repo?: string): SpecFilterOptions {
  const all = placements(specs);
  const byRepository = Map.groupBy(all, (entry) => repoValue(entry.repository));
  const repositories = [...byRepository.entries()]
    .map(([value, entries]) => ({
      value,
      repository: entries[0]!.repository,
      count: countSpecs(entries),
    }))
    .toSorted((left, right) => compareRepositories(left.repository, right.repository));

  const scoped = (repo !== undefined && byRepository.get(repo)) || all;
  const byArea = Map.groupBy(scoped, (entry) => `${repoValue(entry.repository)}\n${entry.area}`);
  const areas = [...byArea.values()]
    .map((entries) => {
      const { repository, area } = entries[0]!;
      return { repo: repoValue(repository), repository, area, count: countSpecs(entries) };
    })
    .toSorted(
      (left, right) =>
        compareRepositories(left.repository, right.repository) ||
        left.area.localeCompare(right.area),
    );
  return { repositories, areas };
}

/**
 * The filter with every value that names nothing in the specs dropped: an unknown repository,
 * an Area outside the chosen repository, an Area without a repository, or blank search.
 * Takes the {@link filterOptions} for `filter.repo`.
 */
export function effectiveFilter(
  { repositories, areas }: SpecFilterOptions,
  filter: SpecFilter,
): SpecFilter {
  const q = filter.q?.trim();
  const repo = repositories.some((option) => option.value === filter.repo)
    ? filter.repo
    : undefined;
  const area =
    repo !== undefined && areas.some((option) => option.area === filter.area)
      ? filter.area
      : undefined;
  return {
    ...(q ? { q } : {}),
    ...(repo === undefined ? {} : { repo }),
    ...(area === undefined ? {} : { area }),
  };
}

function matches(entry: Placement, filter: SpecFilter): boolean {
  if (filter.repo !== undefined && repoValue(entry.repository) !== filter.repo) return false;
  if (filter.area !== undefined && entry.area !== filter.area) return false;
  if (!filter.q) return true;
  const needle = filter.q.toLowerCase();
  return (
    entry.spec.capability.toLowerCase().includes(needle) ||
    entry.area.toLowerCase().includes(needle)
  );
}

/**
 * Matching specs grouped by repository, then Area. The same Area path under two repositories
 * forms two groups; groups without a matching spec are left out. Pass an
 * {@link effectiveFilter}.
 */
export function groupSpecs(specs: StudioSpec[], filter: SpecFilter = {}): SpecRepositoryGroup[] {
  const matching = placements(specs).filter((entry) => matches(entry, filter));
  return [...Map.groupBy(matching, (entry) => repoValue(entry.repository)).values()]
    .map((entries) => ({
      repository: entries[0]!.repository,
      areas: [...Map.groupBy(entries, (entry) => entry.area)]
        .map(([area, areaEntries]) => ({
          area,
          specs: [...new Set(areaEntries.map((entry) => entry.spec))],
        }))
        .toSorted((left, right) => left.area.localeCompare(right.area)),
    }))
    .toSorted((left, right) => compareRepositories(left.repository, right.repository));
}
