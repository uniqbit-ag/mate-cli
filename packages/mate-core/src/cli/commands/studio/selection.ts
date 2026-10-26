import { createHash } from "node:crypto";

import type { StudioInventory, StudioInventoryCompanion } from "./inventory";

export type StudioView = "dashboard" | "workflow" | "specs" | "skills" | "vault" | "reports";

export const STUDIO_VIEWS: readonly StudioView[] = [
  "dashboard",
  "workflow",
  "specs",
  "skills",
  "vault",
  "reports",
];

export const COMPANION_PARAM = "companion";
export const VIEW_PARAM = "view";
export const REFRESH_PARAM = "refresh";
export const FILE_PARAM = "path";
export const DIR_PARAM = "dir";
export const MODE_PARAM = "mode";

/** Every URL parameter Studio names; no other module writes one out. */
export const STUDIO_PARAMS: readonly string[] = [
  COMPANION_PARAM,
  VIEW_PARAM,
  REFRESH_PARAM,
  FILE_PARAM,
  DIR_PARAM,
  MODE_PARAM,
];

/** Filled into a prompt when no change is named, so a prompt is never half-written. */
export const CHANGE_PLACEHOLDER = "<change-name>";

/** Filled into pre-explore prompts, which run before any change exists. */
export const IDEA_PLACEHOLDER = "<idea>";

const DIGEST_LENGTH = 10;

interface SelectionBase {
  companionDigest: string | null;
  /** One-shot: only the `refresh` move sets it, and every other move clears it. */
  refresh: boolean;
}

/** An open file is read rendered or edited raw; read is every other value. */
export type VaultMode = "read" | "edit";

export interface StudioVaultSelection extends SelectionBase {
  view: "vault";
  openPath: string | null;
  /** Only meaningful with an open file, and only where the write path is reached. */
  mode: VaultMode;
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
    mode: params.get(MODE_PARAM) === "edit" ? "edit" : "read",
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
  if (view === "vault") return { ...base, view, openPath: null, mode: "read", openDir: null };
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
    mode: "read",
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
    mode: "read",
    openDir: dir,
  };
}

/** The open file in the other mode; a selection with no open file is returned as it is. */
export function withMode(selection: StudioVaultSelection, mode: VaultMode): StudioVaultSelection {
  return selection.openPath ? { ...selection, mode, refresh: false } : selection;
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
    if (selection.openPath && selection.mode === "edit") {
      fields.push({ name: MODE_PARAM, value: "edit" });
    }
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
