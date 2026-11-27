import { isDeepStrictEqual } from "node:util";

import { effectiveSets, isVariableSet, serverVariables } from "../../../lib/mcp-manager/resolve";
import {
  McpManagerConflictError,
  readMcpManager,
  writeMcpManager,
  type McpManagerPatch,
  type McpManagerSnapshot,
} from "../../../lib/mcp-manager/store";
import type {
  McpManagerAudienceSelection,
  McpManagerConfig,
  McpManagerSelection,
} from "../../../lib/mcp-manager/types";
import { validateMcpManagerConfig } from "../../../lib/mcp-manager/validate";
import { ConfigError } from "../../../lib/orchestrator/types";

type Env = Record<string, string | undefined>;

/** What the MCP view edits: the root section and each declared audience's selection. */
export interface McpManagerState {
  /** Null when the companion declares no `mcpManager`. */
  catalog: McpManagerConfig | null;
  audiences: Record<string, McpManagerAudienceSelection>;
}

/** A variable a server reads and whether Studio's environment sets it; never its value. */
export interface McpVariableStatus {
  name: string;
  set: boolean;
}

/** What core derives from a state, so the browser reimplements no precedence. */
export interface McpManagerDerived {
  /** Effective server names for the base set and per audience. */
  effective: McpManagerSnapshot["effective"];
  /** Per catalog server, the variables it reads. */
  variables: Record<string, McpVariableStatus[]>;
}

export interface McpManagerView extends McpManagerState, McpManagerDerived {
  /** The concurrency token a save carries. */
  token: string;
}

/** A state's derived data, or core's validation error for it. */
export type McpManagerPreview = ({ ok: true } & McpManagerDerived) | { ok: false; reason: string };

export type McpManagerSaveResult =
  | { kind: "saved"; view: McpManagerView }
  /** `framework.yaml` changed after the read; nothing was written. */
  | { kind: "conflict"; current: McpManagerView };

/** The state as `framework.yaml` would hold it, for core's validation and resolution. */
function rawOf(state: McpManagerState) {
  return {
    ...(state.catalog ? { mcpManager: state.catalog } : {}),
    audiences: Object.fromEntries(
      Object.entries(state.audiences).map(([name, selection]) => [name, { mcpManager: selection }]),
    ),
  };
}

function variablesOf(catalog: McpManagerConfig | null, env: Env): McpManagerDerived["variables"] {
  return Object.fromEntries(
    Object.entries(catalog?.servers ?? {}).map(([server, declared]) => [
      server,
      serverVariables(declared).map((name) => ({ name, set: isVariableSet(env, name) })),
    ]),
  );
}

function viewOf(snapshot: McpManagerSnapshot, env: Env): McpManagerView {
  return { ...snapshot, variables: variablesOf(snapshot.catalog, env) };
}

export async function readMcpManagerView(companionPath: string, env: Env): Promise<McpManagerView> {
  return viewOf(await readMcpManager(companionPath), env);
}

export function previewMcpManager(state: McpManagerState, env: Env): McpManagerPreview {
  try {
    const raw = rawOf(state);
    validateMcpManagerConfig(raw);
    return {
      ok: true,
      effective: effectiveSets(raw, Object.keys(state.audiences)),
      variables: variablesOf(state.catalog, env),
    };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { ok: false, reason: error.message };
  }
}

/** Without empty lists; undefined when it names nothing. */
function selectionOf(selection: McpManagerSelection | undefined): McpManagerSelection | undefined {
  const { servers = [], groups = [] } = selection ?? {};
  if (servers.length === 0 && groups.length === 0) return undefined;
  return { ...(servers.length > 0 ? { servers } : {}), ...(groups.length > 0 ? { groups } : {}) };
}

function catalogOf(catalog: McpManagerConfig | null): McpManagerConfig | null {
  const { servers = {}, groups = {}, enabled } = catalog ?? {};
  const hasServers = Object.keys(servers).length > 0;
  const hasGroups = Object.keys(groups).length > 0;
  if (!hasServers && !hasGroups) return null;
  const base = selectionOf(enabled);
  return {
    ...(hasServers ? { servers } : {}),
    ...(hasGroups ? { groups } : {}),
    ...(base ? { enabled: base } : {}),
  };
}

function audienceOf(
  selection: McpManagerAudienceSelection | undefined,
): McpManagerAudienceSelection | null {
  const enable = selectionOf(selection?.enable);
  const disable = selectionOf(selection?.disable);
  if (!enable && !disable) return null;
  return { ...(enable ? { enable } : {}), ...(disable ? { disable } : {}) };
}

/**
 * Only what differs from `current`, so a save rewrites no untouched part and its comments
 * stay. Covers the declared audiences `next` names: a save never creates one.
 */
function patchOf(next: McpManagerState, current: McpManagerSnapshot): McpManagerPatch {
  const patch: McpManagerPatch = {};
  const catalog = catalogOf(next.catalog);
  if (!isDeepStrictEqual(catalog, catalogOf(current.catalog))) patch.catalog = catalog;
  for (const [name, held] of Object.entries(current.audiences)) {
    // Declared after the client's read, so it never saw it: an overwrite leaves it alone.
    if (!Object.hasOwn(next.audiences, name)) continue;
    const selection = audienceOf(next.audiences[name]);
    if (isDeepStrictEqual(selection, audienceOf(held))) continue;
    patch.audiences = { ...patch.audiences, [name]: selection };
  }
  return patch;
}

/** Writes the whole next state; throws the loader's error when it is invalid. */
export async function saveMcpManagerView(
  companionPath: string,
  next: McpManagerState,
  token: string,
  env: Env,
): Promise<McpManagerSaveResult> {
  validateMcpManagerConfig(rawOf(next));
  try {
    const patch = patchOf(next, await readMcpManager(companionPath));
    return {
      kind: "saved",
      view: viewOf(await writeMcpManager(companionPath, patch, token), env),
    };
  } catch (error) {
    if (!(error instanceof McpManagerConflictError)) throw error;
    return { kind: "conflict", current: await readMcpManagerView(companionPath, env) };
  }
}
