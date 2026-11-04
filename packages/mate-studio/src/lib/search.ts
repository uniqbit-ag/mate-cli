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
}

/**
 * Forgiving like the server's own parsing: an unknown value selects nothing rather than failing.
 * Reads the mode with core's precedence, so an unknown `studioMode` never revives a legacy `role`.
 */
export function validateStudioSearch(raw: {
  companion?: unknown;
  studioMode?: unknown;
  role?: unknown;
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
  return search;
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
