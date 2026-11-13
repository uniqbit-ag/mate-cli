import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../../framework";
import { ConfigError, type PluginDeclaration } from "../../../lib/orchestrator/types";

export const AUDIENCE_ENV = "MATE_AUDIENCE";

/**
 * Mate 0.18.4 saved the base set under `audiences.base`. That shape is read
 * back for compatibility, never written: the next save uses the root shape.
 */
export const BASE_AUDIENCE = "base";

/** The keys 0.18.4 moved under `audiences.base`; companion-wide keys stayed at the root. */
export const BASE_AUDIENCE_KEYS = ["capabilities", "plugins", "studio"] as const;

export type AudienceResolution =
  | { ok: true; active: string | null }
  | { ok: false; requested: string; declared: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluginList(value: unknown): unknown[] {
  return isRecord(value) && Array.isArray(value.plugins) ? value.plugins : [];
}

function audienceEntry(raw: unknown, audience: string | null): unknown {
  if (audience === null || audience === BASE_AUDIENCE) return undefined;
  if (!isRecord(raw) || !isRecord(raw.audiences)) return undefined;
  return Object.hasOwn(raw.audiences, audience) ? raw.audiences[audience] : undefined;
}

function studioAgent(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.studio) || !isRecord(value.studio.terminal)) {
    return undefined;
  }
  return value.studio.terminal.agent;
}

/**
 * The base set at the root, whichever shape the file uses: `audiences.base`
 * keys are lifted to the root and `base` leaves `audiences`. A file in the
 * root shape is returned as it is. Throws when a key is declared in both
 * places, or `audiences.base` holds a key the base set does not have.
 */
export function normalizeBaseAudience<T>(raw: T): T {
  if (!isRecord(raw) || !isRecord(raw.audiences) || !Object.hasOwn(raw.audiences, BASE_AUDIENCE)) {
    return raw;
  }
  const { [BASE_AUDIENCE]: baseEntry, ...others } = raw.audiences;
  const lifted: Record<string, unknown> = { ...raw };
  if (isRecord(baseEntry)) {
    for (const [key, value] of Object.entries(baseEntry)) {
      if (!(BASE_AUDIENCE_KEYS as readonly string[]).includes(key)) {
        throw new ConfigError(
          `audiences.${BASE_AUDIENCE} may contain only ${BASE_AUDIENCE_KEYS.join(", ")}; "${key}" belongs at the root of framework.yaml.`,
        );
      }
      if (Object.hasOwn(raw, key)) {
        throw new ConfigError(
          `"${key}" is declared both at the root of framework.yaml and under audiences.${BASE_AUDIENCE}; keep one.`,
        );
      }
      lifted[key] = value;
    }
  }
  if (Object.keys(others).length > 0) lifted.audiences = others;
  else delete lifted.audiences;
  return lifted as T;
}

/** `MATE_AUDIENCE` from the environment; unset, empty or blank means none. */
export function readAudienceSelection(env: Record<string, string | undefined>): string | null {
  const value = env[AUDIENCE_ENV]?.trim();
  return value ? value : null;
}

/** Audience names declared by raw parsed `framework.yaml`, in declared order. */
export function declaredAudiences(raw: unknown): string[] {
  return isRecord(raw) && isRecord(raw.audiences)
    ? Object.keys(raw.audiences).filter((name) => name !== BASE_AUDIENCE)
    : [];
}

export function resolveAudience(raw: unknown, audience: string | null): AudienceResolution {
  if (audience === null || audience === BASE_AUDIENCE) return { ok: true, active: null };
  const declared = declaredAudiences(raw);
  if (declared.includes(audience)) return { ok: true, active: audience };
  return { ok: false, requested: audience, declared };
}

/**
 * Base plugins followed by the active audience's, each declaration keeping
 * its own `policy` and `config`. An unknown audience contributes nothing.
 */
export function effectivePluginDeclarations(raw: unknown, audience: string | null): unknown[] {
  return [...pluginList(normalizeBaseAudience(raw)), ...pluginList(audienceEntry(raw, audience))];
}

/** The ordinary install that writes and installs `audience`'s workspace (`null`: the shared one). */
export function audienceInstallCommand(audience: string | null): string {
  const install = `${FRAMEWORK_NAME} install`;
  return audience === null ? install : `${AUDIENCE_ENV}=${audience} ${install}`;
}

/** A raw `plugins` entry with the workspace it installs into and loads from. */
export interface OriginPluginEntry {
  entry: unknown;
  /** `null` for a base plugin, else the audience declaring it. */
  audience: string | null;
}

/** `effectivePluginDeclarations`, each entry keeping its origin. */
export function effectivePluginEntries(raw: unknown, audience: string | null): OriginPluginEntry[] {
  const active = resolveAudience(raw, audience);
  const name = active.ok ? active.active : null;
  return [
    ...pluginList(normalizeBaseAudience(raw)).map((entry) => ({ entry, audience: null })),
    ...pluginList(audienceEntry(raw, name)).map((entry) => ({ entry, audience: name })),
  ];
}

/** One plugin workspace an install run owns. */
export interface PluginInstallTarget {
  /** `null` for the shared workspace, else the audience's own. */
  audience: string | null;
  declarations: PluginDeclaration[];
}

/**
 * Install targets of an already validated config: the base plugins, plus the
 * active audience's. No other audience is a target, so a run can neither
 * install nor relock it. `base` and an undeclared audience select none.
 */
export function pluginInstallTargets(
  config: unknown,
  audience: string | null,
): PluginInstallTarget[] {
  const targets: PluginInstallTarget[] = [
    {
      audience: null,
      declarations: pluginList(normalizeBaseAudience(config)) as PluginDeclaration[],
    },
  ];
  const resolved = resolveAudience(config, audience);
  if (resolved.ok && resolved.active !== null) {
    targets.push({
      audience: resolved.active,
      declarations: pluginList(audienceEntry(config, resolved.active)) as PluginDeclaration[],
    });
  }
  return targets;
}

/** Packages declared under any audience, the ones that never belong in the shared workspace. */
export function audiencePluginPackages(raw: unknown): Set<string> {
  const packages = new Set<string>();
  for (const name of declaredAudiences(raw)) {
    for (const entry of pluginList(audienceEntry(raw, name))) {
      if (isRecord(entry) && typeof entry.package === "string") packages.add(entry.package);
    }
  }
  return packages;
}

/** Operator-facing message for a `MATE_AUDIENCE` the companion does not declare. */
export function describeUnknownAudience(
  resolution: Extract<AudienceResolution, { ok: false }>,
): string {
  const declared = resolution.declared.length > 0 ? resolution.declared.join(", ") : "none";
  return `unknown audience "${resolution.requested}" (${AUDIENCE_ENV}); declared audiences: ${declared}`;
}

/**
 * The active audience's Studio default agent, else the base one. Returned
 * as found: the caller owns rejecting a value that is not a safe name.
 */
export function effectiveStudioAgent(raw: unknown, audience: string | null): unknown {
  return studioAgent(audienceEntry(raw, audience)) ?? studioAgent(normalizeBaseAudience(raw));
}

/**
 * Raw read of the companion's `framework.yaml`, the base set at the root
 * whichever shape the file uses. Deliberately avoids `ConfigStore.load()` —
 * hydration runs on every invocation and must never create or migrate config
 * files as a side effect.
 */
export async function readFrameworkRaw(companionPath: string): Promise<unknown> {
  let raw: unknown;
  try {
    const text = await fs.readFile(
      path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
      "utf8",
    );
    raw = (parse(text) as unknown) ?? null;
  } catch {
    return null;
  }
  /** Outside the catch: a base key in both places is the operator's to fix, never silently base-less. */
  return normalizeBaseAudience(raw);
}

export async function readEffectiveDeclarations(
  companionPath: string,
  audience: string | null,
): Promise<unknown[]> {
  return effectivePluginDeclarations(await readFrameworkRaw(companionPath), audience);
}

export async function readEffectiveEntries(
  companionPath: string,
  audience: string | null,
): Promise<OriginPluginEntry[]> {
  return effectivePluginEntries(await readFrameworkRaw(companionPath), audience);
}
