import fs from "node:fs/promises";
import path from "node:path";

import type { McpEntryDescriptor } from "./claude-format";

// OpenCode V2 config format primitives, plus the one-time V1-to-V2 normalization
// used while reconciling an existing companion config. This module owns file
// formats only — which entries are Mate-managed is the callers' knowledge.

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
  return [
    ...(Array.isArray(config.plugin) ? config.plugin : []),
    ...(Array.isArray(config.plugins) ? config.plugins : []),
  ];
}

function normalizePluginReference(reference: unknown): unknown {
  if (Array.isArray(reference) && typeof reference[0] === "string" && isRecord(reference[1])) {
    return { package: reference[0], options: reference[1] };
  }
  return reference;
}

/** Replace plugin references using the V2 key; an empty list removes it. */
export function setOpenCodePluginReferences(config: OpenCodeConfig, references: unknown[]): void {
  delete config.plugin;
  if (references.length === 0) {
    delete config.plugins;
    return;
  }
  config.plugins = references.map(normalizePluginReference);
}

/** V2 splits one V1 timeout into separate catalog and execution budgets. */
function splitMcpTimeout(timeout: number): { catalog: number; execution: number } {
  return { catalog: timeout, execution: timeout };
}

function normalizeMcpEntry(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const entry = { ...value };
  if (typeof entry.enabled === "boolean") {
    if (entry.disabled === undefined) entry.disabled = !entry.enabled;
    delete entry.enabled;
  }
  if (typeof entry.timeout === "number") {
    entry.timeout = splitMcpTimeout(entry.timeout);
  }
  for (const [legacy, current] of [
    ["clientId", "client_id"],
    ["clientSecret", "client_secret"],
    ["callbackPort", "callback_port"],
    ["redirectUri", "redirect_uri"],
  ] as const) {
    if (entry[legacy] !== undefined) {
      if (entry[current] === undefined) entry[current] = entry[legacy];
      delete entry[legacy];
    }
  }
  return entry;
}

const LEGACY_PERMISSION_ACTIONS: Record<string, string> = {
  bash: "shell",
  task: "subagent",
  write: "edit",
  patch: "edit",
};

function permissionAction(legacyAction: string): string {
  return LEGACY_PERMISSION_ACTIONS[legacyAction] ?? legacyAction;
}

function appendPermissionRules(target: unknown[], permissions: unknown): void {
  if (!isRecord(permissions)) return;
  for (const [legacyAction, rules] of Object.entries(permissions)) {
    const action = permissionAction(legacyAction);
    if (rules === "allow" || rules === "deny" || rules === "ask") {
      target.push({ action, resource: "*", effect: rules });
      continue;
    }
    if (!isRecord(rules)) continue;
    for (const [resource, effect] of Object.entries(rules)) {
      if (effect === "allow" || effect === "deny" || effect === "ask") {
        target.push({ action, resource, effect });
      }
    }
  }
}

function dedupePluginReferences(config: OpenCodeConfig): void {
  const references = getOpenCodePluginReferences(config);
  if (references.length === 0 && !("plugin" in config)) return;

  const seen = new Set<string>();
  setOpenCodePluginReferences(
    config,
    references.map(normalizePluginReference).filter((entry) => {
      const key = JSON.stringify(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

function normalizeCompaction(config: OpenCodeConfig): void {
  if (!isRecord(config.compaction)) return;

  const compaction = { ...config.compaction };
  const keep = isRecord(compaction.keep) ? { ...compaction.keep } : {};
  if (keep.tokens === undefined && compaction.preserve_recent_tokens !== undefined) {
    keep.tokens = compaction.preserve_recent_tokens;
  }
  if (compaction.buffer === undefined && compaction.reserved !== undefined) {
    compaction.buffer = compaction.reserved;
  }
  delete compaction.preserve_recent_tokens;
  delete compaction.reserved;
  // V2 compaction uses checkpoint-based summaries, not V1 pruning/tail turns.
  delete compaction.prune;
  delete compaction.tail_turns;
  if (Object.keys(keep).length > 0) compaction.keep = keep;
  else delete compaction.keep;
  config.compaction = compaction;
}

/** Moves flat V1 `mcp.<name>` entries under `mcp.servers`; an existing V2 entry wins per key. */
function normalizeMcpServers(config: OpenCodeConfig): void {
  if (!isRecord(config.mcp)) return;

  const mcp = { ...config.mcp };
  const servers = isRecord(mcp.servers) ? { ...mcp.servers } : {};
  for (const [name, value] of Object.entries(mcp)) {
    if (name === "servers" || name === "timeout") continue;
    const previous = normalizeMcpEntry(value);
    const current = servers[name];
    servers[name] =
      isRecord(previous) && isRecord(current) ? { ...previous, ...current } : (current ?? previous);
    delete mcp[name];
  }
  for (const [name, entry] of Object.entries(servers)) {
    servers[name] = normalizeMcpEntry(entry);
  }
  if (Object.keys(servers).length > 0) mcp.servers = servers;
  else delete mcp.servers;
  if (typeof mcp.timeout === "number") {
    mcp.timeout = splitMcpTimeout(mcp.timeout);
  }
  config.mcp = mcp;
}

function normalizeExperimentalMcpTimeout(config: OpenCodeConfig): void {
  if (!isRecord(config.experimental) || typeof config.experimental.mcp_timeout !== "number") return;

  const timeout = config.experimental.mcp_timeout;
  const mcp = isRecord(config.mcp) ? { ...config.mcp } : {};
  const existingTimeout = isRecord(mcp.timeout) ? { ...mcp.timeout } : {};
  mcp.timeout = {
    catalog: existingTimeout.catalog ?? timeout,
    execution: existingTimeout.execution ?? timeout,
  };
  config.mcp = mcp;
  const experimental = { ...config.experimental };
  delete experimental.mcp_timeout;
  if (Object.keys(experimental).length > 0) config.experimental = experimental;
  else delete config.experimental;
}

/** Converts V1 `permission` maps and disabled `tools` into V2 rules ahead of existing ones. */
function normalizePermissions(config: OpenCodeConfig): void {
  const permissionRules: unknown[] = [];
  appendPermissionRules(permissionRules, config.permission);
  if (isRecord(config.tools)) {
    for (const [toolName, enabled] of Object.entries(config.tools)) {
      if (enabled === false) {
        permissionRules.push({ action: permissionAction(toolName), resource: "*", effect: "deny" });
      }
    }
    delete config.tools;
  }
  const currentPermissions = Array.isArray(config.permissions) ? config.permissions : [];
  if (permissionRules.length > 0 || "permission" in config) {
    config.permissions = [...permissionRules, ...currentPermissions];
  }
  delete config.permission;
}

function normalizeSkills(config: OpenCodeConfig): void {
  if (!isRecord(config.skills)) return;

  const legacySkills = config.skills;
  const normalizedSkills = [
    ...(Array.isArray(legacySkills.paths) ? legacySkills.paths : []),
    ...(Array.isArray(legacySkills.urls) ? legacySkills.urls : []),
  ];
  config.skills = [...new Set(normalizedSkills.filter((entry) => typeof entry === "string"))];
}

/** Normalize supported V1 config syntax to V2 without discarding unrelated settings. */
export function normalizeOpenCodeConfig(config: OpenCodeConfig): OpenCodeConfig {
  dedupePluginReferences(config);
  normalizeCompaction(config);
  normalizeMcpServers(config);
  normalizeExperimentalMcpTimeout(config);
  normalizePermissions(config);
  normalizeSkills(config);
  return config;
}

function mergeConfig(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = target[key];
    if (key === "permissions" && Array.isArray(targetValue) && Array.isArray(sourceValue)) {
      target[key] = [...targetValue, ...sourceValue];
      continue;
    }
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
        config = normalizeOpenCodeConfig(parsed);
      }
    } catch {
      // Ignore invalid inherited config content rather than breaking launch.
    }
  }

  mergeConfig(config, overlay);

  if (options.appendSkillPaths && options.appendSkillPaths.length > 0) {
    const skills = Array.isArray(config.skills) ? config.skills : [];
    const existingPaths = new Set(skills);
    config.skills = [
      ...skills,
      ...options.appendSkillPaths.filter((skillPath) => !existingPaths.has(skillPath)),
    ];
  }

  return JSON.stringify(config);
}

/** Map a provider-agnostic MCP descriptor to OpenCode V2's server entry shape. */
export function toOpenCodeMcpEntry(descriptor: McpEntryDescriptor): Record<string, unknown> {
  if (descriptor.url) {
    return { type: "remote", url: descriptor.url, disabled: false };
  }
  return {
    type: "local",
    command: [descriptor.command ?? "", ...(descriptor.args ?? [])].filter(Boolean),
    ...(descriptor.env ? { environment: descriptor.env } : {}),
    disabled: false,
  };
}

/**
 * Reconcile a single server under `mcp.servers` while preserving every
 * unrelated key. `entry: null` removes the server; removal never creates the
 * file, and an emptied `mcp.servers` map is dropped.
 */
export async function updateOpenCodeMcpServer(
  configPath: string,
  name: string,
  entry: Record<string, unknown> | null,
): Promise<void> {
  const { present, config } = await readOpenCodeConfig(configPath);
  if (entry === null && !present) return;

  normalizeOpenCodeConfig(config);
  const mcp: Record<string, unknown> = isRecord(config.mcp) ? { ...config.mcp } : {};
  const servers: Record<string, unknown> = isRecord(mcp.servers) ? { ...mcp.servers } : {};
  if (entry === null) {
    if (!(name in servers)) return;
    delete servers[name];
  } else {
    servers[name] = normalizeMcpEntry(entry);
  }

  const next = { ...config };
  if (Object.keys(servers).length > 0) {
    mcp.servers = servers;
    next.mcp = mcp;
  } else {
    delete mcp.servers;
    if (Object.keys(mcp).length > 0) next.mcp = mcp;
    else delete next.mcp;
  }
  await writeOpenCodeConfig(configPath, next);
}
