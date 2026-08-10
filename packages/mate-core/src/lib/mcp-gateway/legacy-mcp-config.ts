import fs from "node:fs/promises";
import path from "node:path";

import {
  COMPANION_MCP_CONFIG_RELATIVE_PATH,
  loadCompanionMcpConfig,
  type CompanionMcpConfig,
  type CompanionMcpConfigIssue,
  type CompanionMcpServer,
} from "./companion-mcp-config";

export const LEGACY_OPENCODE_CONFIG_RELATIVE_PATH = path.join(".opencode", "opencode.json");
export const LEGACY_CLAUDE_MCP_RELATIVE_PATH = ".mcp.json";

export interface ResolvedCompanionMcpServers extends CompanionMcpConfig {
  /** One warning per legacy file that contributed servers, naming the migration target. */
  deprecations: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

function stringEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") env[key] = entry;
  }
  return env;
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON in ${filePath}: ${(error as Error).message}`);
  }
}

/**
 * Legacy `<companion>/.opencode/opencode.json` `mcp` entries
 * (`{type: "local", command: [bin, ...args], environment, enabled}`).
 */
function mapOpenCodeEntry(
  name: string,
  value: unknown,
  companionPath: string,
): { server?: CompanionMcpServer; issue?: CompanionMcpConfigIssue } {
  if (!isRecord(value)) {
    return { issue: { server: name, message: "legacy opencode mcp entry must be an object" } };
  }
  if (value.type !== undefined && value.type !== "local") {
    return {
      issue: {
        server: name,
        message: `legacy opencode mcp entry has unsupported type "${String(value.type)}" (only "local" servers can move behind the gateway)`,
      },
    };
  }
  const command = stringArray(value.command);
  if (!command || command.length === 0) {
    return { issue: { server: name, message: "legacy opencode mcp entry needs a command array" } };
  }
  return {
    server: {
      name,
      command: command[0]!,
      args: command.slice(1),
      env: stringEnv(value.environment),
      cwd: companionPath,
      isolation: "shared",
      enabled: value.enabled !== false,
    },
  };
}

/** Legacy `<companion>/.mcp.json` `mcpServers` entries (Claude format: command/args/env). */
function mapClaudeEntry(
  name: string,
  value: unknown,
  companionPath: string,
): { server?: CompanionMcpServer; issue?: CompanionMcpConfigIssue } {
  if (!isRecord(value)) {
    return { issue: { server: name, message: "legacy .mcp.json entry must be an object" } };
  }
  if (value.type !== undefined && value.type !== "stdio") {
    return {
      issue: {
        server: name,
        message: `legacy .mcp.json entry has unsupported type "${String(value.type)}" (only stdio servers can move behind the gateway)`,
      },
    };
  }
  if (typeof value.command !== "string" || value.command.length === 0) {
    return { issue: { server: name, message: "legacy .mcp.json entry needs a string command" } };
  }
  const args = value.args === undefined ? [] : stringArray(value.args);
  if (args === null) {
    return { issue: { server: name, message: "legacy .mcp.json entry args must be strings" } };
  }
  return {
    server: {
      name,
      command: value.command,
      args,
      env: stringEnv(value.env),
      cwd: companionPath,
      isolation: "shared",
      enabled: true,
    },
  };
}

interface LegacySource {
  relativePath: string;
  read(companionPath: string): Promise<Record<string, unknown> | undefined>;
  map: typeof mapOpenCodeEntry;
}

const LEGACY_SOURCES: LegacySource[] = [
  {
    relativePath: LEGACY_OPENCODE_CONFIG_RELATIVE_PATH,
    async read(companionPath) {
      const parsed = await readJsonFile(
        path.join(companionPath, LEGACY_OPENCODE_CONFIG_RELATIVE_PATH),
      );
      if (parsed === undefined) return undefined;
      if (!isRecord(parsed) || !isRecord(parsed.mcp)) return undefined;
      return parsed.mcp;
    },
    map: mapOpenCodeEntry,
  },
  {
    relativePath: LEGACY_CLAUDE_MCP_RELATIVE_PATH,
    async read(companionPath) {
      const parsed = await readJsonFile(path.join(companionPath, LEGACY_CLAUDE_MCP_RELATIVE_PATH));
      if (parsed === undefined) return undefined;
      if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return undefined;
      return parsed.mcpServers;
    },
    map: mapClaudeEntry,
  },
];

/**
 * Full companion MCP server resolution: canonical `.mate/mcp.yaml` plus legacy
 * files during the migration window. Canonical entries win name collisions;
 * legacy files that contribute anything produce a deprecation warning.
 */
export async function resolveCompanionMcpServers(
  companionPath: string,
): Promise<ResolvedCompanionMcpServers> {
  const canonical = await loadCompanionMcpConfig(companionPath);
  const servers = [...canonical.servers];
  const issues = [...canonical.issues];
  const deprecations: string[] = [];
  const seen = new Set(servers.map((server) => server.name));

  for (const source of LEGACY_SOURCES) {
    let entries: Record<string, unknown> | undefined;
    try {
      entries = await source.read(companionPath);
    } catch (error) {
      issues.push({ message: (error as Error).message });
      continue;
    }
    if (!entries || Object.keys(entries).length === 0) continue;

    deprecations.push(
      `companion MCP servers in ${source.relativePath} are deprecated: move them to ${COMPANION_MCP_CONFIG_RELATIVE_PATH} (same servers, mate-owned format)`,
    );

    for (const [name, value] of Object.entries(entries)) {
      if (seen.has(name)) continue;
      const { server, issue } = source.map(name, value, companionPath);
      if (issue) issues.push(issue);
      if (!server) continue;
      seen.add(name);
      servers.push(server);
    }
  }

  return { servers, issues, deprecations };
}
