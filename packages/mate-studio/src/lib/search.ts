import {
  COMPANION_DIGEST_PATTERN,
  COMPANION_PARAM,
  LEGACY_ROLE_PARAM,
  requestedMode,
  STUDIO_MODE_PARAM,
  viewsFor,
  type StudioMode,
  type StudioView,
} from "@uniqbit/mate-core/studio";

/** The address every view shares: which companion, through which Studio mode. */
export interface StudioSearch {
  companion?: string;
  /** The mode asked for; the server's startup profile decides the effective one. */
  studioMode?: StudioMode;
  usageDays?: number;
  usageRepository?: string;
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
  return search;
}

/** The Specs view's search and filters; absent means All. */
export interface SpecsSearch {
  q?: string;
  repo?: string;
  area?: string;
}

/** The router JSON-parses search values, so `?q=2026` arrives as a number; read it as typed. */
function searchText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return undefined;
  }
  return String(value).trim() || undefined;
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
