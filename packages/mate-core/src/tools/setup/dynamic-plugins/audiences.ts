import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../../framework";
import type { PluginDeclaration } from "../../../lib/orchestrator/types";

export const AUDIENCE_ENV = "MATE_AUDIENCE";

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
  if (audience === null || !isRecord(raw) || !isRecord(raw.audiences)) return undefined;
  return Object.hasOwn(raw.audiences, audience) ? raw.audiences[audience] : undefined;
}

function studioAgent(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.studio) || !isRecord(value.studio.terminal)) {
    return undefined;
  }
  return value.studio.terminal.agent;
}

/** `MATE_AUDIENCE` from the environment; unset, empty or blank means none. */
export function readAudienceSelection(env: Record<string, string | undefined>): string | null {
  const value = env[AUDIENCE_ENV]?.trim();
  return value ? value : null;
}

/** Audience names declared by raw parsed `framework.yaml`, in declared order. */
export function declaredAudiences(raw: unknown): string[] {
  return isRecord(raw) && isRecord(raw.audiences) ? Object.keys(raw.audiences) : [];
}

export function resolveAudience(raw: unknown, audience: string | null): AudienceResolution {
  if (audience === null) return { ok: true, active: null };
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
  return studioAgent(audienceEntry(raw, audience)) ?? studioAgent(raw);
}

/**
 * Raw read of the companion's `framework.yaml`. Deliberately avoids
 * `ConfigStore.load()` — hydration runs on every invocation and must never
 * create or migrate config files as a side effect.
 */
export async function readFrameworkRaw(companionPath: string): Promise<unknown> {
  try {
    const text = await fs.readFile(
      path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
      "utf8",
    );
    return (parse(text) as unknown) ?? null;
  } catch {
    return null;
  }
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
