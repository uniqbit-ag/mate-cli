import { COMPANION_DIGEST_PATTERN, STUDIO_ROLES, type StudioRole } from "@uniqbit/mate-core/studio";

/** The address every view shares: which companion, through which role's lens. */
export interface StudioSearch {
  companion?: string;
  role?: StudioRole;
}

/** Forgiving like the server's own parsing: an unknown value selects nothing rather than failing. */
export function validateStudioSearch(raw: { companion?: unknown; role?: unknown }): StudioSearch {
  const search: StudioSearch = {};
  if (typeof raw.companion === "string" && COMPANION_DIGEST_PATTERN.test(raw.companion)) {
    search.companion = raw.companion;
  }
  if (typeof raw.role === "string" && (STUDIO_ROLES as readonly string[]).includes(raw.role)) {
    search.role = raw.role as StudioRole;
  }
  return search;
}
