import { createHash } from "node:crypto";

import type { StudioInventory, StudioInventoryCompanion } from "./inventory";

export type StudioView = "dashboard" | "workflow" | "specs" | "skills" | "vault";

export const STUDIO_VIEWS: readonly StudioView[] = [
  "dashboard",
  "workflow",
  "specs",
  "skills",
  "vault",
];

export const COMPANION_PARAM = "companion";
export const VIEW_PARAM = "view";
export const REFRESH_PARAM = "refresh";
export const FILE_PARAM = "path";
export const DIR_PARAM = "dir";

/** Every URL parameter Studio names; no other module writes one out. */
export const STUDIO_PARAMS: readonly string[] = [
  COMPANION_PARAM,
  VIEW_PARAM,
  REFRESH_PARAM,
  FILE_PARAM,
  DIR_PARAM,
];

/** Filled into a prompt when no change is named, so a prompt is never half-written. */
export const CHANGE_PLACEHOLDER = "<change-name>";

const DIGEST_LENGTH = 10;

interface SelectionBase {
  companionDigest: string | null;
  /** One-shot: only the `refresh` move sets it, and every other move clears it. */
  refresh: boolean;
}

export interface StudioVaultSelection extends SelectionBase {
  view: "vault";
  openPath: string | null;
  /** A folder of the listed tree; never looked up on disk. */
  openDir: string | null;
}

export interface StudioPlainSelection extends SelectionBase {
  view: Exclude<StudioView, "vault">;
}

export type StudioSelection = StudioVaultSelection | StudioPlainSelection;

export interface SelectionField {
  name: string;
  value: string;
}

/**
 * Derived from the companion path alone: stable enough to bookmark, and short
 * enough that no absolute Companion Repository path is written into browser
 * history, autocomplete, or a shared URL.
 */
/** The shape a digest must have to be trusted from outside the server: a URL, a browser store. */
export const COMPANION_DIGEST_PATTERN = new RegExp(`^[0-9a-f]{${DIGEST_LENGTH}}$`);

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

function readText(value: string | null): string | null {
  return value?.trim() || null;
}

/** An empty or malformed digest selects no companion, as an unmatched one already does. */
function readDigest(value: string | null): string | null {
  const digest = readText(value);
  return digest && COMPANION_DIGEST_PATTERN.test(digest) ? digest : null;
}

function readBase(params: URLSearchParams): SelectionBase {
  return {
    companionDigest: readDigest(params.get(COMPANION_PARAM)),
    refresh: params.get(REFRESH_PARAM) === "1",
  };
}

function readVault(params: URLSearchParams): StudioVaultSelection {
  return {
    ...readBase(params),
    view: "vault",
    openPath: readText(params.get(FILE_PARAM)),
    openDir: readText(params.get(DIR_PARAM)),
  };
}

/** Forgiving: parameters the named view does not have are ignored. */
export function parse(url: URL): StudioSelection {
  const view = readView(url.searchParams.get(VIEW_PARAM));
  if (view === "vault") return readVault(url.searchParams);
  return { ...readBase(url.searchParams), view };
}

/** For the `/api/vault/*` routes, which imply the vault view whatever `view` says. */
export function parseVaultSelection(url: URL): StudioVaultSelection {
  return readVault(url.searchParams);
}

/** Drops the vault's target. */
export function switchView(selection: StudioSelection, view: StudioView): StudioSelection {
  const base = { companionDigest: selection.companionDigest, refresh: false };
  if (view === "vault") return { ...base, view, openPath: null, openDir: null };
  return { ...base, view };
}

/** Keeps the view and drops the vault's target: it belongs to the companion being left. */
export function switchCompanion(
  selection: StudioSelection,
  digest: string | null,
): StudioSelection {
  return { ...switchView(selection, selection.view), companionDigest: digest };
}

export function openFile(selection: StudioSelection, path: string): StudioVaultSelection {
  return {
    companionDigest: selection.companionDigest,
    refresh: false,
    view: "vault",
    openPath: path,
    openDir: null,
  };
}

/** `null` opens the companion root. */
export function openFolder(selection: StudioSelection, dir: string | null): StudioVaultSelection {
  return {
    companionDigest: selection.companionDigest,
    refresh: false,
    view: "vault",
    openPath: null,
    openDir: dir,
  };
}

export function refresh(selection: StudioSelection): StudioSelection {
  return { ...selection, refresh: true };
}

/** Omits defaults (the Dashboard view, an unset target), so URLs stay short. */
export function toFields(selection: StudioSelection): SelectionField[] {
  const fields: SelectionField[] = [];
  if (selection.companionDigest) {
    fields.push({ name: COMPANION_PARAM, value: selection.companionDigest });
  }
  if (selection.view !== "dashboard") fields.push({ name: VIEW_PARAM, value: selection.view });
  if (selection.view === "vault") {
    if (selection.openPath) fields.push({ name: FILE_PARAM, value: selection.openPath });
    if (selection.openDir) fields.push({ name: DIR_PARAM, value: selection.openDir });
  }
  if (selection.refresh) fields.push({ name: REFRESH_PARAM, value: "1" });
  return fields;
}

export function toSearchParams(selection: StudioSelection): URLSearchParams {
  return new URLSearchParams(toFields(selection).map(({ name, value }) => [name, value]));
}

export function toHref(selection: StudioSelection, route = "/"): string {
  const query = toSearchParams(selection).toString();
  return query ? `${route}?${query}` : route;
}
