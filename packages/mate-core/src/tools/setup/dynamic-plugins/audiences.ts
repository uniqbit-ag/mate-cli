import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../../framework";
import { ConfigError, type PluginDeclaration } from "../../../lib/orchestrator/types";

export const AUDIENCE_ENV = "MATE_AUDIENCE";

/** The reserved audience holding the base set: always applied, never selected or listed. */
export const BASE_AUDIENCE = "base";

/** The base set's audience-scoped keys; companion-wide keys stay at the root. */
export const BASE_AUDIENCE_KEYS = ["capabilities", "plugins", "studio"] as const;

export type AudienceResolution =
  | { ok: true; active: string | null }
  | { ok: false; requested: string; declared: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluginList(value: unknown): unknown[] {
  if (
    isRecord(value) &&
    isRecord(value.audiences) &&
    Object.hasOwn(value.audiences, BASE_AUDIENCE)
  ) {
    return pluginList(normalizeBaseAudience(value));
  }
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

/** `MATE_AUDIENCE=base` selects the base set alone, the same as no audience. */
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
  return [...pluginList(raw), ...pluginList(audienceEntry(raw, audience))];
}

/** One effective declaration and its source: `null` for base, else the audience name. */
export interface SourcedDeclaration {
  entry: unknown;
  audience: string | null;
}

/** `effectivePluginDeclarations`, each entry marked with the source that declared it. */
export function effectivePluginDeclarationSources(
  raw: unknown,
  audience: string | null,
): SourcedDeclaration[] {
  return [
    ...pluginList(raw).map((entry) => ({ entry, audience: null })),
    ...pluginList(audienceEntry(raw, audience)).map((entry) => ({ entry, audience })),
  ];
}

/** The declarations of one audience only, without base. */
export function audiencePluginDeclarations(raw: unknown, audience: string): unknown[] {
  return pluginList(audienceEntry(raw, audience));
}

/**
 * Base plugins followed by every audience's, for installation only: a
 * package shared by audiences appears once since validation guarantees one
 * version. Runtime declarations must come from `effectivePluginDeclarations`.
 */
export function allPluginDeclarations(raw: unknown): unknown[] {
  const all = [...pluginList(raw)];
  for (const name of declaredAudiences(raw)) {
    all.push(...pluginList(audienceEntry(raw, name)));
  }
  const seen = new Set<string>();
  return all.filter((entry) => {
    if (!isRecord(entry) || typeof entry.package !== "string") return true;
    const key = `${entry.package}@${String(entry.version)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Operator-facing message for a `MATE_AUDIENCE` the companion does not declare. */
export function describeUnknownAudience(
  resolution: Extract<AudienceResolution, { ok: false }>,
): string {
  const declared = resolution.declared.length > 0 ? resolution.declared.join(", ") : "none";
  return `unknown audience "${resolution.requested}" (${AUDIENCE_ENV}); declared audiences: ${declared}`;
}

/** Install-time declarations of an already validated config: base plus every audience. */
export function installPluginDeclarations(config: unknown): PluginDeclaration[] {
  return allPluginDeclarations(config) as PluginDeclaration[];
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

export async function readAllDeclarations(companionPath: string): Promise<unknown[]> {
  return allPluginDeclarations(await readFrameworkRaw(companionPath));
}
