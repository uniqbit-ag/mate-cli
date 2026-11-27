import {
  COMPANION_DIGEST_PATTERN,
  COMPANION_PARAM,
  frictionViewDays,
  LEGACY_ROLE_PARAM,
  REPORT_KINDS,
  requestedMode,
  STATE_FILTERS,
  STUDIO_MODE_PARAM,
  SUBJECT_TYPES,
  viewsFor,
  type FrictionViewDays,
  type ReportKind,
  type StateFilter,
  type SubjectType,
  type StudioMode,
  type StudioView,
} from "@uniqbit/mate-core/studio";

const FRICTION_SORTS = ["repeats", "recent"] as const;
export type FrictionSort = (typeof FRICTION_SORTS)[number];

/** The option `value` names, or `undefined`. */
export const oneOf = <T extends string>(options: readonly T[], value: unknown): T | undefined =>
  options.find((option) => option === value);

/** The address every view shares: which companion, through which Studio mode. */
export interface StudioSearch {
  companion?: string;
  /** The mode asked for; the server's startup profile decides the effective one. */
  studioMode?: StudioMode;
  usageDays?: number;
  usageRepository?: string;
  /** Absent for any other period; the view then shows its default. */
  frictionDays?: FrictionViewDays;
  /** Absent, or a value naming no option, means the control's default. */
  frictionState?: StateFilter;
  frictionType?: SubjectType;
  frictionKind?: ReportKind;
  frictionSort?: FrictionSort;
}

/**
 * Forgiving like the server's own parsing: an unknown value selects nothing rather than failing.
 * Reads the mode with core's precedence, so an unknown `studioMode` never revives a legacy `role`.
 */
export function validateStudioSearch(raw: {
  companion?: unknown;
  studioMode?: unknown;
  role?: unknown;
  usageDays?: unknown;
  usageRepository?: unknown;
  frictionDays?: unknown;
  frictionState?: unknown;
  frictionType?: unknown;
  frictionKind?: unknown;
  frictionSort?: unknown;
}): StudioSearch {
  const search: StudioSearch = {};
  if (typeof raw.companion === "string" && COMPANION_DIGEST_PATTERN.test(raw.companion)) {
    search.companion = raw.companion;
  }
  const params = new URLSearchParams();
  if (raw.studioMode !== undefined) params.set(STUDIO_MODE_PARAM, String(raw.studioMode));
  if (typeof raw.role === "string") params.set(LEGACY_ROLE_PARAM, raw.role);
  const mode = requestedMode(params);
  if (mode) search.studioMode = mode;
  const days = Number(raw.usageDays);
  if (/^\d+$/.test(String(raw.usageDays)) && Number.isInteger(days) && days >= 1 && days <= 365)
    search.usageDays = days;
  if (typeof raw.usageRepository === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(raw.usageRepository))
    search.usageRepository = raw.usageRepository;
  const frictionDays = frictionViewDays(raw.frictionDays);
  if (frictionDays) search.frictionDays = frictionDays;
  const frictionState = oneOf(STATE_FILTERS, raw.frictionState);
  if (frictionState) search.frictionState = frictionState;
  const frictionType = oneOf(SUBJECT_TYPES, raw.frictionType);
  if (frictionType) search.frictionType = frictionType;
  const frictionKind = oneOf(REPORT_KINDS, raw.frictionKind);
  if (frictionKind) search.frictionKind = frictionKind;
  const frictionSort = oneOf(FRICTION_SORTS, raw.frictionSort);
  if (frictionSort) search.frictionSort = frictionSort;
  return search;
}

/**
 * The router's search parser: each value stays the text of the address. The default
 * JSON-parses values, so a digest such as `647426e241` became a number and was dropped.
 */
export function parseStudioSearch(searchStr: string): Record<string, string> {
  const first = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(searchStr)) {
    if (!first.has(key)) first.set(key, unquoted(value));
  }
  return Object.fromEntries(first);
}

/** Addresses written before {@link parseStudioSearch} quote a value that reads as JSON. */
function unquoted(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * Writes each value as plain text, as {@link parseStudioSearch} reads it back. A string
 * starting with `"` is JSON-quoted so {@link unquoted} strips only the quotes added here.
 * An object or array is written as JSON, not `[object Object]`, and read back as that text.
 */
export function stringifyStudioSearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    const asJson =
      typeof value === "object" || (typeof value === "string" && value.startsWith('"'));
    params.set(key, asJson ? JSON.stringify(value) : String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The Specs view's search and filters; absent means All. */
export interface SpecsSearch {
  q?: string;
  repo?: string;
  area?: string;
}

function searchText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/** Values naming nothing in the companion's specs are dropped by the view, not here. */
export function validateSpecsSearch(raw: {
  q?: unknown;
  repo?: unknown;
  area?: unknown;
}): SpecsSearch {
  const q = searchText(raw.q);
  const repo = searchText(raw.repo);
  const area = searchText(raw.area);
  return { ...(q ? { q } : {}), ...(repo ? { repo } : {}), ...(area ? { area } : {}) };
}

/**
 * The address to replace this one with so it names the effective mode and no legacy `role`,
 * or `null` when it already does. A view the mode is not offered lands on the Overview.
 */
export function canonicalHref(
  pathname: string,
  searchStr: string,
  view: StudioView | undefined,
  studioMode: StudioMode,
): string | null {
  const params = new URLSearchParams(searchStr);
  const offered = view === undefined || viewsFor(studioMode).includes(view);
  if (params.get(STUDIO_MODE_PARAM) === studioMode && !params.has(LEGACY_ROLE_PARAM) && offered) {
    return null;
  }
  if (!offered) {
    const landing = new URLSearchParams();
    const companion = params.get(COMPANION_PARAM);
    if (companion !== null) landing.set(COMPANION_PARAM, companion);
    landing.set(STUDIO_MODE_PARAM, studioMode);
    return `/?${landing}`;
  }
  params.delete(LEGACY_ROLE_PARAM);
  params.set(STUDIO_MODE_PARAM, studioMode);
  return `${pathname}?${params}`;
}
