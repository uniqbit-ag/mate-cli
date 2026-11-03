import { createHash } from "node:crypto";

import type { StudioInventory, StudioInventoryCompanion } from "./inventory";

export type StudioView =
  | "dashboard"
  | "factory"
  | "workflow"
  | "specs"
  | "skills"
  | "vault"
  | "reports";

export const STUDIO_VIEWS: readonly StudioView[] = [
  "dashboard",
  "factory",
  "workflow",
  "specs",
  "skills",
  "vault",
  "reports",
];

/** A lens on the views offered, never access control. */
export type StudioMode = "engineering" | "analysis";

export const STUDIO_MODES: readonly StudioMode[] = ["engineering", "analysis"];

/** Views only the mode is offered, in navigation order. */
export const MODE_VIEWS: Readonly<Record<StudioMode, readonly StudioView[]>> = {
  engineering: ["dashboard", "factory", "workflow", "skills"],
  // The same `dashboard` id; `Content` renders each mode's own Overview.
  analysis: ["dashboard"],
};

/** Views every mode is offered, in navigation order. */
export const SHARED_VIEWS: readonly StudioView[] = ["vault", "specs", "reports"];

/** Where a mode lands when its URL names no view, or one it is not offered. */
export const LANDING_VIEW: Readonly<Record<StudioMode, StudioView>> = {
  engineering: "dashboard",
  analysis: "dashboard",
};

export function viewsFor(mode: StudioMode): readonly StudioView[] {
  return [...MODE_VIEWS[mode], ...SHARED_VIEWS];
}

/** How Studio was started; fixed for the server's life, never read from a request. */
export type StudioProfile = "standard" | "appliance";

export const STUDIO_PROFILES: readonly StudioProfile[] = ["standard", "appliance"];

/** Which modes a profile enables and where it lands. Presentation only, not a security boundary. */
export interface StudioModePolicy {
  readonly profile: StudioProfile;
  readonly enabled: readonly StudioMode[];
  readonly defaultMode: StudioMode;
}

const POLICIES: Readonly<Record<StudioProfile, StudioModePolicy>> = {
  standard: Object.freeze({
    profile: "standard",
    enabled: Object.freeze(["engineering", "analysis"] as const),
    defaultMode: "engineering",
  }),
  appliance: Object.freeze({
    profile: "appliance",
    enabled: Object.freeze(["analysis"] as const),
    defaultMode: "analysis",
  }),
};

export function modePolicy(profile: StudioProfile = "standard"): StudioModePolicy {
  return POLICIES[profile];
}

const STANDARD_POLICY = modePolicy("standard");

/** Old bookmarks' `role` values; read as input only, never written. */
export const LEGACY_ROLE_MODES: Readonly<Record<string, StudioMode>> = {
  "product-engineer": "engineering",
  "business-analyst": "analysis",
};

export const COMPANION_PARAM = "companion";
export const STUDIO_MODE_PARAM = "studioMode";
/** Input-only alias of `studioMode`. */
export const LEGACY_ROLE_PARAM = "role";
export const VIEW_PARAM = "view";
export const REFRESH_PARAM = "refresh";
export const FILE_PARAM = "path";
export const DIR_PARAM = "dir";
export const MODE_PARAM = "mode";

/** Every URL parameter Studio names; no other module writes one out. */
export const STUDIO_PARAMS: readonly string[] = [
  COMPANION_PARAM,
  STUDIO_MODE_PARAM,
  LEGACY_ROLE_PARAM,
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
  studioMode: StudioMode;
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

/**
 * The mode a request asks for, before the policy: a present `studioMode` wins, even an
 * unknown one (which asks for none); a known legacy `role` is read only without it.
 */
export function requestedMode(params: URLSearchParams): StudioMode | null {
  const canonical = params.get(STUDIO_MODE_PARAM);
  if (canonical !== null) {
    return STUDIO_MODES.includes(canonical as StudioMode) ? (canonical as StudioMode) : null;
  }
  const legacy = params.get(LEGACY_ROLE_PARAM) ?? "";
  return Object.hasOwn(LEGACY_ROLE_MODES, legacy) ? LEGACY_ROLE_MODES[legacy]! : null;
}

/** A mode asked for that the policy does not enable, or none, is the policy's default. */
export function effectiveMode(requested: StudioMode | null, policy: StudioModePolicy): StudioMode {
  return requested && policy.enabled.includes(requested) ? requested : policy.defaultMode;
}

/** A view the mode is not offered reads as the mode's landing view. */
function readView(value: string | null, mode: StudioMode): StudioView {
  return viewsFor(mode).includes(value as StudioView) ? (value as StudioView) : LANDING_VIEW[mode];
}

function readText(value: string | null): string | null {
  return value?.trim() || null;
}

/** An empty or malformed digest selects no companion, as an unmatched one already does. */
function readDigest(value: string | null): string | null {
  const digest = readText(value);
  return digest && COMPANION_DIGEST_PATTERN.test(digest) ? digest : null;
}

function readBase(params: URLSearchParams, policy: StudioModePolicy): SelectionBase {
  return {
    companionDigest: readDigest(params.get(COMPANION_PARAM)),
    studioMode: effectiveMode(requestedMode(params), policy),
    refresh: params.get(REFRESH_PARAM) === "1",
  };
}

function readVault(params: URLSearchParams, policy: StudioModePolicy): StudioVaultSelection {
  return {
    ...readBase(params, policy),
    view: "vault",
    openPath: readText(params.get(FILE_PARAM)),
    mode: params.get(MODE_PARAM) === "edit" ? "edit" : "read",
    openDir: readText(params.get(DIR_PARAM)),
  };
}

/**
 * Forgiving: parameters the named view does not have are ignored. The policy is the
 * server's startup profile; no parameter can enable a mode it disables.
 */
export function parse(url: URL, policy: StudioModePolicy = STANDARD_POLICY): StudioSelection {
  const base = readBase(url.searchParams, policy);
  const view = readView(url.searchParams.get(VIEW_PARAM), base.studioMode);
  if (view === "vault") return readVault(url.searchParams, policy);
  return { ...base, view };
}

/** For the `/api/vault/*` routes, which imply the vault view whatever `view` says. */
export function parseVaultSelection(
  url: URL,
  policy: StudioModePolicy = STANDARD_POLICY,
): StudioVaultSelection {
  return readVault(url.searchParams, policy);
}

/** Drops the vault's target. */
export function switchView(selection: StudioSelection, view: StudioView): StudioSelection {
  const base = {
    companionDigest: selection.companionDigest,
    studioMode: selection.studioMode,
    refresh: false,
  };
  if (view === "vault") return { ...base, view, openPath: null, mode: "read", openDir: null };
  return { ...base, view };
}

/**
 * Keeps the view, and the vault's target with it, when the mode is offered the
 * view; otherwise lands on the mode's landing view.
 */
export function switchMode(selection: StudioSelection, studioMode: StudioMode): StudioSelection {
  if (viewsFor(studioMode).includes(selection.view)) {
    return { ...selection, studioMode, refresh: false };
  }
  return switchView({ ...selection, studioMode }, LANDING_VIEW[studioMode]);
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
    studioMode: selection.studioMode,
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
    studioMode: selection.studioMode,
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

/**
 * Always carries the effective mode, never a legacy `role`; omits the mode's landing view
 * and an unset target, so URLs stay short.
 */
export function toFields(selection: StudioSelection): SelectionField[] {
  const fields: SelectionField[] = [];
  if (selection.companionDigest) {
    fields.push({ name: COMPANION_PARAM, value: selection.companionDigest });
  }
  fields.push({ name: STUDIO_MODE_PARAM, value: selection.studioMode });
  if (selection.view !== LANDING_VIEW[selection.studioMode]) {
    fields.push({ name: VIEW_PARAM, value: selection.view });
  }
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
