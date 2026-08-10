import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

/** Canonical mate-owned companion MCP config, relative to the companion root. */
export const COMPANION_MCP_CONFIG_RELATIVE_PATH = path.join(".mate", "mcp.yaml");

/**
 * One resolved companion MCP server definition. Everything a companion
 * configures — including credentials in `env`/`args` — is passed through to
 * the spawned backend unchanged.
 */
export interface CompanionMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Absolute; relative configured values resolve against the companion root. */
  cwd: string;
  /** `connection` forces one backend per gateway connection; default is shared. */
  isolation: "shared" | "connection";
  enabled: boolean;
}

export interface CompanionMcpConfigIssue {
  server?: string;
  message: string;
}

export interface CompanionMcpConfig {
  servers: CompanionMcpServer[];
  /** Invalid entries are skipped, never fatal — one bad server must not take down the rest. */
  issues: CompanionMcpConfigIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

function parseEnv(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return null;
    env[key] = entry;
  }
  return env;
}

/** Valid server names keep the flat `mate__<tool>` namespace unambiguous. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function parseServer(
  name: string,
  value: unknown,
  companionPath: string,
): { server?: CompanionMcpServer; issue?: CompanionMcpConfigIssue } {
  if (!SERVER_NAME_PATTERN.test(name)) {
    return {
      issue: { server: name, message: `invalid server name (use letters, digits, "-", "_")` },
    };
  }
  if (!isRecord(value)) {
    return { issue: { server: name, message: "server entry must be a mapping" } };
  }
  if (typeof value.command !== "string" || value.command.length === 0) {
    return { issue: { server: name, message: "missing required string field: command" } };
  }
  const args = parseStringArray(value.args);
  if (args === null) {
    return { issue: { server: name, message: "args must be a list of strings" } };
  }
  const env = parseEnv(value.env);
  if (env === null) {
    return { issue: { server: name, message: "env must be a mapping of string values" } };
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    return { issue: { server: name, message: "cwd must be a string" } };
  }
  if (
    value.isolation !== undefined &&
    value.isolation !== "shared" &&
    value.isolation !== "connection"
  ) {
    return { issue: { server: name, message: `isolation must be "shared" or "connection"` } };
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return { issue: { server: name, message: "enabled must be a boolean" } };
  }
  return {
    server: {
      name,
      command: value.command,
      args,
      env,
      cwd: path.resolve(companionPath, typeof value.cwd === "string" ? value.cwd : "."),
      isolation: value.isolation === "connection" ? "connection" : "shared",
      enabled: value.enabled !== false,
    },
  };
}

export function parseCompanionMcpConfig(raw: string, companionPath: string): CompanionMcpConfig {
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    return { servers: [], issues: [{ message: `invalid YAML: ${(error as Error).message}` }] };
  }
  if (parsed === null || parsed === undefined) return { servers: [], issues: [] };
  if (!isRecord(parsed) || (parsed.servers !== undefined && !isRecord(parsed.servers))) {
    return {
      servers: [],
      issues: [{ message: "config must be a mapping with a servers section" }],
    };
  }
  const servers: CompanionMcpServer[] = [];
  const issues: CompanionMcpConfigIssue[] = [];
  for (const [name, value] of Object.entries(parsed.servers ?? {})) {
    const { server, issue } = parseServer(name, value, companionPath);
    if (server) servers.push(server);
    if (issue) issues.push(issue);
  }
  return { servers, issues };
}

/** Missing file is a valid empty config; only the canonical mate-owned file is read here. */
export async function loadCompanionMcpConfig(companionPath: string): Promise<CompanionMcpConfig> {
  const configPath = path.join(companionPath, COMPANION_MCP_CONFIG_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: [], issues: [] };
    throw error;
  }
  return parseCompanionMcpConfig(raw, companionPath);
}

export function companionMcpConfigPath(companionPath: string): string {
  return path.join(companionPath, COMPANION_MCP_CONFIG_RELATIVE_PATH);
}
