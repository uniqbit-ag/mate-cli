import { audienceEntry, normalizeBaseAudience } from "../../tools/setup/dynamic-plugins/audiences";
import {
  type McpManagerAudienceSelection,
  type McpManagerConfig,
  type McpManagerSelection,
  parseHeaderRef,
  type ResolvedMcpServer,
} from "./types";
import { isRecord } from "./validate";

function members(section: McpManagerConfig, groups: string[] | undefined): string[] {
  return (groups ?? []).flatMap((group) => section.groups?.[group] ?? []);
}

function audienceSelection(raw: unknown, audience: string | null): McpManagerAudienceSelection {
  const entry = audienceEntry(raw, audience);
  return isRecord(entry) && isRecord(entry.mcpManager)
    ? (entry.mcpManager as McpManagerAudienceSelection)
    : {};
}

/** A variable an effective server needs that the environment leaves unset or empty. */
export interface MissingMcpVariable {
  server: string;
  variable: string;
}

/** Variables a server reads: its `env` names and the one each header references. */
export function serverVariables(server: ResolvedMcpServer["server"]): string[] {
  const headers = "headers" in server ? Object.values(server.headers ?? {}) : [];
  const fromHeaders = headers.flatMap((value) => parseHeaderRef(value)?.variable ?? []);
  return [...new Set([...(server.env ?? []), ...fromHeaders])];
}

/** Unset and empty both count as missing. Checks presence only; a value never leaves `env`. */
export function isVariableSet(env: Record<string, string | undefined>, variable: string): boolean {
  return Boolean(env[variable]);
}

export function missingMcpVariables(
  raw: unknown,
  audience: string | null,
  env: Record<string, string | undefined>,
): MissingMcpVariable[] {
  return resolveMcpServers(raw, audience).flatMap(({ name, server }) =>
    serverVariables(server)
      .filter((variable) => !isVariableSet(env, variable))
      .map((variable) => ({ server: name, variable })),
  );
}

/**
 * The effective servers of an already validated `framework.yaml` for
 * `audience`, ordered by name. Group decisions apply before server decisions,
 * so a named server beats a group; `null`, `base` or an undeclared audience
 * gives the base set.
 */
export function resolveMcpServers(raw: unknown, audience: string | null): ResolvedMcpServer[] {
  const normalized = normalizeBaseAudience(raw);
  if (!isRecord(normalized) || !isRecord(normalized.mcpManager)) return [];
  const section = normalized.mcpManager as McpManagerConfig;
  const base: McpManagerSelection = section.enabled ?? {};
  const { enable = {}, disable = {} } = audienceSelection(normalized, audience);

  const names = new Set([...(base.servers ?? []), ...members(section, base.groups)]);
  for (const name of members(section, enable.groups)) names.add(name);
  for (const name of members(section, disable.groups)) names.delete(name);
  for (const name of enable.servers ?? []) names.add(name);
  for (const name of disable.servers ?? []) names.delete(name);

  return [...names]
    .filter((name) => section.servers?.[name] !== undefined)
    .toSorted()
    .map((name) => ({ name, server: section.servers![name] }));
}

/** Effective server names for the base set and for each of `audiences`. */
export function effectiveSets(
  raw: unknown,
  audiences: readonly string[],
): { base: string[]; audiences: Record<string, string[]> } {
  const names = (audience: string | null) =>
    resolveMcpServers(raw, audience).map((server) => server.name);
  return {
    base: names(null),
    audiences: Object.fromEntries(audiences.map((audience) => [audience, names(audience)])),
  };
}
