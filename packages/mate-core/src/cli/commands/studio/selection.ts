import { createHash } from "node:crypto";

import type { StudioInventory, StudioInventoryCompanion } from "./inventory";

export type StudioView = "dashboard" | "workflow";

export const STUDIO_VIEWS: readonly StudioView[] = ["dashboard", "workflow"];

export const COMPANION_PARAM = "companion";
export const VIEW_PARAM = "view";
export const REFRESH_PARAM = "refresh";

/** Filled into a prompt when no change is named, so a prompt is never half-written. */
export const CHANGE_PLACEHOLDER = "<change-name>";

const DIGEST_LENGTH = 10;

export interface StudioSelection {
  companionDigest: string | null;
  view: StudioView;
  /**
   * One-shot: the refresh control asks for it, and it is never carried forward
   * into the URL another control builds. Switching a view is not a refresh.
   */
  refresh: boolean;
}

/**
 * Derived from the companion path alone: stable enough to bookmark, and short
 * enough that no absolute Companion Repository path is written into browser
 * history, autocomplete, or a shared URL.
 */
export function companionDigest(companionPath: string): string {
  return createHash("sha256").update(companionPath).digest("hex").slice(0, DIGEST_LENGTH);
}

/** An unresolvable digest selects nothing rather than failing the request. */
export function resolveCompanion(
  inventory: StudioInventory,
  digest: string | null,
): StudioInventoryCompanion | null {
  if (!digest) return null;
  return (
    inventory.companions.find((companion) => companionDigest(companion.path) === digest) ?? null
  );
}

function readView(value: string | null): StudioView {
  return STUDIO_VIEWS.includes(value as StudioView) ? (value as StudioView) : "dashboard";
}

export function parseStudioSelection(url: URL): StudioSelection {
  return {
    companionDigest: url.searchParams.get(COMPANION_PARAM)?.trim() || null,
    view: readView(url.searchParams.get(VIEW_PARAM)),
    refresh: url.searchParams.get(REFRESH_PARAM) === "1",
  };
}
