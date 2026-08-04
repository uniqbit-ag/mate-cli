import fs from "node:fs/promises";
import path from "node:path";

import type { McpEntryDescriptor } from "./claude-format";

// OpenCode runtime config format primitives: parse/serialize for
// `opencode.json`/`tui.json`, plugin-reference array handling, and MCP entry
// shapes. This module owns the file formats only — which entries are
// Mate-managed is the callers' (Runtime Surface) knowledge.

export type OpenCodeConfig = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tolerant read; `present` distinguishes absent/malformed from empty. */
export async function readOpenCodeConfig(
  configPath: string,
): Promise<{ present: boolean; config: OpenCodeConfig }> {
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
    if (isRecord(parsed)) {
      return { present: true, config: parsed };
    }
  } catch {
    // Absent or unparseable — start from an empty object.
  }
  return { present: false, config: {} };
}

export async function writeOpenCodeConfig(
  configPath: string,
  config: OpenCodeConfig,
): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function getOpenCodePluginReferences(config: OpenCodeConfig): unknown[] {
  return Array.isArray(config.plugin) ? config.plugin : [];
}

/** Replace the plugin array in place; an empty list removes the key. */
export function setOpenCodePluginReferences(config: OpenCodeConfig, references: unknown[]): void {
  if (references.length === 0) {
    delete config.plugin;
    return;
  }
  config.plugin = references;
}

function mergeConfig(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = target[key];
    if (isRecord(targetValue) && isRecord(sourceValue)) {
      mergeConfig(targetValue, sourceValue);
      continue;
    }

    target[key] = sourceValue;
  }
}

/**
 * Merge an overlay into the launch-time `OPENCODE_CONFIG_CONTENT` env value
 * (overlay wins on scalar conflicts) and return the serialized result. Invalid
 * inherited content is ignored rather than breaking the launch.
 */
export function mergeOpenCodeConfigContent(
  overlay: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  options: { appendSkillPaths?: string[] } = {},
): string {
  let config: Record<string, unknown> = {};
  const existing = env.OPENCODE_CONFIG_CONTENT;

  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (isRecord(parsed)) {
        config = parsed;
      }
    } catch {
      // Ignore invalid inherited config content rather than breaking launch.
    }
  }

  mergeConfig(config, overlay);

  if (options.appendSkillPaths && options.appendSkillPaths.length > 0) {
    const skills = isRecord(config.skills) ? config.skills : {};
    const paths = Array.isArray(skills.paths) ? skills.paths : [];
    const existingPaths = new Set(paths);
    skills.paths = [
      ...paths,
      ...options.appendSkillPaths.filter((skillPath) => !existingPaths.has(skillPath)),
    ];
    config.skills = skills;
  }

  return JSON.stringify(config);
}

/** Map a provider-agnostic MCP descriptor to OpenCode's `mcp` entry shape. */
export function toOpenCodeMcpEntry(descriptor: McpEntryDescriptor): Record<string, unknown> {
  if (descriptor.url) {
    return { type: "remote", url: descriptor.url, enabled: true };
  }
  return {
    type: "local",
    command: [descriptor.command ?? "", ...(descriptor.args ?? [])].filter(Boolean),
    ...(descriptor.env ? { environment: descriptor.env } : {}),
    enabled: true,
  };
}

/**
 * Reconcile a single server entry in the `mcp` map while preserving every
 * unrelated key. `entry: null` removes the server; removal never creates the
 * file, and an emptied `mcp` map is dropped entirely.
 */
export async function updateOpenCodeMcpServer(
  configPath: string,
  name: string,
  entry: Record<string, unknown> | null,
): Promise<void> {
  const { present, config } = await readOpenCodeConfig(configPath);
  if (entry === null && !present) return;

  const mcp: Record<string, unknown> = isRecord(config.mcp) ? { ...config.mcp } : {};
  if (entry === null) {
    if (!(name in mcp)) return;
    delete mcp[name];
  } else {
    mcp[name] = entry;
  }

  const next = { ...config };
  if (Object.keys(mcp).length > 0) {
    next.mcp = mcp;
  } else {
    delete next.mcp;
  }
  await writeOpenCodeConfig(configPath, next);
}
