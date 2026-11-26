import { raisedEngineRange } from "../orchestrator/engine-floor";
import { ConfigError } from "../orchestrator/types";
import { MCP_MANAGER_TRANSPORTS, type McpManagerConfig, type McpManagerHeaderRef } from "./types";

/** First Mate release that reads `mcpManager`; the `engines.mate` floor a save sets. */
export const MCP_MANAGER_VERSION = "1.0.0-canary.9";

export const MCP_MANAGER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const MCP_MANAGER_VARIABLE_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
export const MCP_MANAGER_HEADER_PREFIXES = ["Bearer ", "Basic ", "Token "] as const;

const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
const HEADER_VALUE_PATTERN = /^(Bearer |Basic |Token )?\$\{([A-Z_][A-Z0-9_]*)\}$/;

const SECTION_KEYS = ["servers", "groups", "enabled"] as const;
const STDIO_KEYS = ["command", "args", "env"] as const;
const REMOTE_KEYS = ["url", "transport", "headers", "env"] as const;
const SELECTION_KEYS = ["servers", "groups"] as const;
const AUDIENCE_KEYS = ["enable", "disable"] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new ConfigError(message);
}

function checkKeys(where: string, value: Record<string, unknown>, allowed: readonly string[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${where}: unknown key "${key}" (allowed: ${allowed.join(", ")}).`);
    }
  }
}

/** `${NAME}` with an optional known scheme prefix, or null for anything else. */
export function parseHeaderRef(value: unknown): McpManagerHeaderRef | null {
  if (typeof value !== "string") return null;
  const match = HEADER_VALUE_PATTERN.exec(value);
  return match ? { prefix: match[1] ?? "", variable: match[2] } : null;
}

function validateEnv(where: string, env: unknown): void {
  if (!Array.isArray(env)) {
    fail(
      `${where}: env lists variable names only, e.g. env: [ACME_TOKEN]; it is not a mapping of values.`,
    );
  }
  env.forEach((entry, index) => {
    if (typeof entry !== "string" || !MCP_MANAGER_VARIABLE_PATTERN.test(entry)) {
      fail(
        `${where}: env entry ${index + 1} is not a variable name (must match ${MCP_MANAGER_VARIABLE_PATTERN.source}); env lists names only, never values.`,
      );
    }
  });
}

function validateHeaders(where: string, headers: unknown): void {
  if (!isRecord(headers)) fail(`${where}: headers must be a mapping of header name to reference.`);
  for (const [header, value] of Object.entries(headers)) {
    if (!HEADER_NAME_PATTERN.test(header))
      fail(`${where}: header "${header}" is not a header name.`);
    if (parseHeaderRef(value) === null) {
      fail(
        `${where}: header "${header}" must be an optional scheme prefix (${MCP_MANAGER_HEADER_PREFIXES.map((prefix) => prefix.trim()).join(", ")}) followed by exactly one \${NAME} reference; literal values are not allowed.`,
      );
    }
  }
}

/** An absent list is empty. */
function validateStringList(where: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    fail(`${where} must be a list of names.`);
  }
  return value;
}

function validateServer(name: string, server: unknown): void {
  const where = `mcpManager.servers.${name}`;
  if (!MCP_MANAGER_NAME_PATTERN.test(name)) {
    fail(`Invalid MCP server name "${name}": must match ${MCP_MANAGER_NAME_PATTERN.source}.`);
  }
  if (!isRecord(server)) fail(`${where} must be a mapping.`);
  const hasCommand = Object.hasOwn(server, "command");
  const hasUrl = Object.hasOwn(server, "url");
  if (hasCommand && hasUrl) {
    fail(`${where} declares both "command" and "url"; a server has exactly one transport.`);
  }
  if (!hasCommand && !hasUrl) fail(`${where} needs either "command" or "url".`);

  if (hasCommand) {
    checkKeys(where, server, STDIO_KEYS);
    if (typeof server.command !== "string" || server.command.trim() === "") {
      fail(`${where}: command must be a non-empty string.`);
    }
    validateStringList(`${where}.args`, server.args);
  } else {
    checkKeys(where, server, REMOTE_KEYS);
    if (typeof server.url !== "string" || !/^https?:\/\/\S+$/.test(server.url)) {
      fail(`${where}: url must be an http or https URL.`);
    }
    if (
      server.transport !== undefined &&
      !MCP_MANAGER_TRANSPORTS.includes(server.transport as never)
    ) {
      fail(`${where}: transport must be one of ${MCP_MANAGER_TRANSPORTS.join(", ")}.`);
    }
    if (server.headers !== undefined) validateHeaders(where, server.headers);
  }
  if (server.env !== undefined) validateEnv(where, server.env);
}

/** Server and group names a valid root section declares. */
interface Catalog {
  servers: ReadonlySet<string>;
  groups: ReadonlySet<string>;
}

/** An absent selection names nothing. */
function validateSelection(
  where: string,
  selection: unknown,
  catalog: Catalog,
): { servers: string[]; groups: string[] } {
  if (selection === undefined) return { servers: [], groups: [] };
  if (!isRecord(selection)) fail(`${where} must be a mapping with servers and groups lists.`);
  checkKeys(where, selection, SELECTION_KEYS);
  const named = {
    servers: validateStringList(`${where}.servers`, selection.servers),
    groups: validateStringList(`${where}.groups`, selection.groups),
  };
  for (const server of named.servers) {
    if (!catalog.servers.has(server)) fail(`${where}: unknown MCP server "${server}".`);
  }
  for (const group of named.groups) {
    if (!catalog.groups.has(group)) fail(`${where}: unknown MCP server group "${group}".`);
  }
  return named;
}

function catalogOf(section: unknown): Catalog {
  return {
    servers: new Set(
      isRecord(section) && isRecord(section.servers) ? Object.keys(section.servers) : [],
    ),
    groups: new Set(
      isRecord(section) && isRecord(section.groups) ? Object.keys(section.groups) : [],
    ),
  };
}

/** Validates the root `mcpManager` section; error texts never repeat a configured value. */
export function validateMcpManagerSection(section: unknown): asserts section is McpManagerConfig {
  if (!isRecord(section)) fail("mcpManager must be a mapping with servers, groups and enabled.");
  checkKeys("mcpManager", section, SECTION_KEYS);

  if (section.servers !== undefined) {
    if (!isRecord(section.servers)) fail("mcpManager.servers must be a mapping of name to server.");
    for (const [name, server] of Object.entries(section.servers)) validateServer(name, server);
  }
  const catalog = catalogOf(section);

  if (section.groups !== undefined) {
    if (!isRecord(section.groups)) fail("mcpManager.groups must be a mapping of name to servers.");
    for (const [name, members] of Object.entries(section.groups)) {
      if (!MCP_MANAGER_NAME_PATTERN.test(name)) {
        fail(
          `Invalid MCP server group name "${name}": must match ${MCP_MANAGER_NAME_PATTERN.source}.`,
        );
      }
      if (catalog.servers.has(name)) {
        fail(
          `mcpManager: "${name}" names both a server and a group; servers and groups share one namespace.`,
        );
      }
      for (const member of validateStringList(`mcpManager.groups.${name}`, members)) {
        if (!catalog.servers.has(member)) {
          fail(`mcpManager.groups.${name}: unknown MCP server "${member}".`);
        }
      }
    }
  }

  validateSelection("mcpManager.enabled", section.enabled, catalog);
}

/**
 * Validates `audiences.<audience>.mcpManager` against the root catalog
 * (`undefined` when the companion declares none).
 */
export function validateAudienceMcpManager(
  audience: string,
  selection: unknown,
  root: unknown,
): void {
  const where = `audience "${audience}": mcpManager`;
  if (!isRecord(selection)) fail(`${where} must be a mapping with enable and disable.`);
  checkKeys(where, selection, AUDIENCE_KEYS);
  const catalog = catalogOf(root);
  const enable = validateSelection(`${where}.enable`, selection.enable, catalog);
  const disable = validateSelection(`${where}.disable`, selection.disable, catalog);
  for (const kind of ["servers", "groups"] as const) {
    const disabled = new Set(disable[kind]);
    const both = enable[kind].find((name) => disabled.has(name));
    if (both !== undefined) {
      fail(`${where}: "${both}" is both enabled and disabled under ${kind}; keep one.`);
    }
  }
}

/** True when `mcpManager` appears at the root or under any audience. */
export function declaresMcpManager(config: { mcpManager?: unknown; audiences?: unknown }): boolean {
  if (config.mcpManager !== undefined) return true;
  return (
    isRecord(config.audiences) &&
    Object.values(config.audiences).some(
      (audience) => isRecord(audience) && audience.mcpManager !== undefined,
    )
  );
}

/** The `engines.mate` range a save must write when the config declares `mcpManager`, else null. */
export function mcpManagerEngineRange(config: {
  mcpManager?: unknown;
  audiences?: unknown;
  engines?: unknown;
}): string | null {
  return declaresMcpManager(config) ? raisedEngineRange(config.engines, MCP_MANAGER_VERSION) : null;
}

/** The root section and every audience selection of a parsed `framework.yaml`. */
export function validateMcpManagerConfig(config: {
  mcpManager?: unknown;
  audiences?: unknown;
}): void {
  if (config.mcpManager !== undefined) validateMcpManagerSection(config.mcpManager);
  if (!isRecord(config.audiences)) return;
  for (const [name, audience] of Object.entries(config.audiences)) {
    if (isRecord(audience) && audience.mcpManager !== undefined) {
      validateAudienceMcpManager(name, audience.mcpManager, config.mcpManager);
    }
  }
}
