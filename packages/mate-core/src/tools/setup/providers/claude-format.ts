import fs from "node:fs/promises";
import path from "node:path";

// Structurally matches `McpServerDescriptor` from ../plugin; declared here so
// the format module stays dependency-free of the plugin contract (which
// imports hook types from this module).
export interface McpEntryDescriptor {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

// Claude runtime config format primitives: parse/merge/serialize for
// `settings.local.json` (hook maps, permissions) and `.mcp.json`. This module
// owns the file formats only — which entries are Mate-managed is the callers'
// (Runtime Surface) knowledge.

export interface ClaudeHookCommand {
  type?: string;
  command?: string;
  args?: string[];
  timeout?: number;
}

export interface ClaudeHookGroup {
  matcher?: string;
  hooks?: ClaudeHookCommand[];
}

export type ClaudeHookMap = Record<string, ClaudeHookGroup[]>;

export interface ClaudeSettings {
  hooks?: ClaudeHookMap;
  permissions?: { additionalDirectories?: string[]; allow?: string[] } & Record<string, unknown>;
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
  [key: string]: unknown;
}

export interface ClaudeMcpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function hookGroupKey(group: ClaudeHookGroup): string {
  return JSON.stringify(group);
}

/** Append incoming hook groups per event, skipping structurally identical ones. */
export function mergeClaudeHookGroups(
  existingHooks: ClaudeHookMap,
  incomingHooks: ClaudeHookMap,
): ClaudeHookMap {
  const merged: ClaudeHookMap = { ...existingHooks };
  for (const [event, groups] of Object.entries(incomingHooks)) {
    const current = merged[event] ?? [];
    const seen = new Set(current.map(hookGroupKey));
    merged[event] = [...current];
    for (const group of groups ?? []) {
      const key = hookGroupKey(group);
      if (seen.has(key)) continue;
      merged[event].push(group);
      seen.add(key);
    }
  }
  return merged;
}

/** Keep only groups matching `keep`; events left empty are dropped. */
export function filterClaudeHookGroups(
  hooks: ClaudeHookMap,
  keep: (group: ClaudeHookGroup) => boolean,
): ClaudeHookMap {
  const filtered: ClaudeHookMap = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const remaining = (groups ?? []).filter(keep);
    if (remaining.length > 0) {
      filtered[event] = remaining;
    }
  }
  return filtered;
}

/** Tolerant read: absent or malformed settings read as an empty object. */
export async function readClaudeSettings(settingsPath: string): Promise<ClaudeSettings> {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as ClaudeSettings;
    }
  } catch {
    // Absent or unparseable — start from an empty object.
  }
  return {};
}

export async function writeClaudeSettings(
  settingsPath: string,
  settings: ClaudeSettings,
): Promise<void> {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

/** Tolerant read of `.mcp.json`; `present` distinguishes absent from empty. */
export async function readClaudeMcpConfig(
  mcpConfigPath: string,
): Promise<{ present: boolean; config: ClaudeMcpConfig }> {
  try {
    const parsed = JSON.parse(await fs.readFile(mcpConfigPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") {
      return { present: true, config: parsed as ClaudeMcpConfig };
    }
  } catch {
    // Absent or unparseable — start from an empty object.
  }
  return { present: false, config: {} };
}

export async function writeClaudeMcpConfig(
  mcpConfigPath: string,
  config: ClaudeMcpConfig,
): Promise<void> {
  await fs.writeFile(mcpConfigPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Map a provider-agnostic MCP descriptor to Claude's `.mcp.json` entry shape. */
export function toClaudeMcpEntry(descriptor: McpEntryDescriptor): Record<string, unknown> {
  if (descriptor.url) return { url: descriptor.url };
  return {
    command: descriptor.command,
    ...(descriptor.args ? { args: descriptor.args } : {}),
    ...(descriptor.env ? { env: descriptor.env } : {}),
  };
}

/**
 * Reconcile a single server entry in `.mcp.json` while preserving every
 * unrelated key. `entry: null` removes the server; removal never creates the
 * file.
 */
export async function updateClaudeMcpServer(
  mcpConfigPath: string,
  name: string,
  entry: Record<string, unknown> | null,
): Promise<void> {
  const { present, config } = await readClaudeMcpConfig(mcpConfigPath);
  if (entry === null && !present) return;

  const mcpServers: Record<string, unknown> = { ...config.mcpServers };
  if (entry === null) {
    if (!(name in mcpServers)) return;
    delete mcpServers[name];
  } else {
    mcpServers[name] = entry;
  }
  await writeClaudeMcpConfig(mcpConfigPath, { ...config, mcpServers });
}
