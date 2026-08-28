// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import type { FrameworkConfig } from "../../../lib/orchestrator/types";
import { refreshFromTemplate, stripGuidanceBlock } from "../plugins/guidance";
import {
  instructionBlockKey,
  removeManagedBlocksForPlugin,
  upsertManagedBlock,
} from "../context-services";
import type { CapabilityContributionInput, ProviderPlugin, SetupContext } from "../plugin";
import { surfaceRoot } from "../surface-target";
import { mergeDir, pruneEmptyAncestors } from "../utils";
import { stripSectionFromFile, type RemoveHeadingSectionOptions } from "./agent-file-sections";
import { patchSkillTreeMarkdownFiles } from "./skill-tree";
import {
  filterClaudeHookGroups,
  mergeClaudeHookGroups,
  removeManagedHookGroups,
  readClaudeMcpConfig,
  readClaudeSettings,
  toClaudeMcpEntry,
  updateClaudeMcpServer,
  writeClaudeMcpConfig,
  writeClaudeSettings,
  type ClaudeHookGroup,
  type ClaudeSettings,
} from "./claude-format";
import { getSetupRootTemplates } from "./utils";

async function configureClaudeGuidance(companionPath: string): Promise<void> {
  const rootTemplates = getSetupRootTemplates();
  await refreshFromTemplate(
    path.join(companionPath, "CLAUDE.md"),
    path.join(rootTemplates, "TEMPLATE_CLAUDE.md"),
  );
  const legacyClaudeMdPath = path.join(companionPath, ".claude", "CLAUDE.md");
  await stripGuidanceBlock(legacyClaudeMdPath);
  try {
    const content = await fs.readFile(legacyClaudeMdPath, "utf8");
    if (!content.trim()) await fs.unlink(legacyClaudeMdPath);
  } catch {
    /* not present */
  }
  await pruneEmptyAncestors(path.join(companionPath, ".claude"), companionPath);
  await refreshFromTemplate(
    path.join(companionPath, "AGENTS.md"),
    path.join(rootTemplates, "TEMPLATE_AGENTS.md"),
  );
}

const COMPANION_GITIGNORE_ENTRIES = [
  ".claude/settings.local.json",
  ".claude/settings.local.json.bak",
  ".claude/state/",
];

// Hook files earlier releases copied into the companion; the bundled Claude
// plugin replaced them. Setup and launch sync delete stale copies.
const LEGACY_MATE_HOOK_FILES = [
  "validate-artifact-path",
  "mate-session-banner",
  "mate-artifact-finish.sh",
];

async function removeLegacyMateHookFiles(companionPath: string): Promise<void> {
  const hooksDir = path.join(companionPath, ".claude", "hooks");
  for (const name of LEGACY_MATE_HOOK_FILES) {
    try {
      await fs.unlink(path.join(hooksDir, name));
    } catch {
      /* not present */
    }
  }
  await pruneEmptyAncestors(hooksDir, companionPath);
}

// Base `permissions.allow` entries that Claude gets for Mate-managed workflows.
// Read/Edit are scoped to the companion path so routine reads and artifact
// writes of skills, specs, and change artifacts don't prompt for approval on
// every file. Claude Code ignores `Glob()` rules for file-permission checks
// (only Read/Edit rules gate file tools), so no Glob entry is emitted.
function getBaseManagedPermissionEntries(companionPath: string): string[] {
  return [`Bash(${FRAMEWORK_NAME}:*)`, `Read(${companionPath}/**)`, `Edit(${companionPath}/**)`];
}

const LEGACY_MANAGED_PERMISSION_ENTRIES = [
  "Bash($MATE_COMPANION_BIN_PATH/openspec:*)",
  "Bash($MATE_COMPANION_BIN_PATH/graphify:*)",
];

function getAllManagedPermissionEntries(companionPath: string): Set<string> {
  return new Set([
    ...getBaseManagedPermissionEntries(companionPath),
    ...LEGACY_MANAGED_PERMISSION_ENTRIES,
    // Legacy base entry: Claude Code never matched Glob() rules for file
    // permission checks and warns about them, so setup no longer emits it.
    // Keep it managed so re-running setup strips it from existing installs.
    `Glob(${companionPath}/**)`,
  ]);
}

// Resolved path of the companion-owned Claude settings document. This is the
// single source of truth for Mate-managed Claude hooks, permissions, and MCP
// servers; it is loaded at launch via `claude --settings`.
export function getCompanionClaudeSettingsPath(companionPath: string): string {
  return path.join(companionPath, ".claude", "settings.local.json");
}

// Resolved path of the companion-owned `.mcp.json`. Mate writes Mate-managed
// MCP servers here and loads it at launch via `claude --mcp-config`, keeping
// the MCP surface out of the working repo and out of settings.local.json.
export function getCompanionClaudeMcpConfigPath(companionPath: string): string {
  return path.join(companionPath, ".mcp.json");
}

/**
 * The Mate-managed `permissions.allow` entries of one pass, in emitted order.
 * Rendered separately from the settings document so a working-target pass can
 * obtain them without a write.
 */
export function renderManagedClaudePermissionEntries(
  companionPath: string,
  contributions: CapabilityContributionInput[] = [],
): string[] {
  return [
    ...getBaseManagedPermissionEntries(companionPath),
    ...contributions
      .filter((input) => input.enabled)
      .flatMap((input) => input.contributions.permissionEntries ?? []),
  ];
}

/** The Mate-managed `.mcp.json` server map of one pass, as a value. */
export function renderManagedClaudeMcpServers(
  contributions: CapabilityContributionInput[] = [],
): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const input of contributions) {
    if (!input.enabled) continue;
    for (const descriptor of input.contributions.mcpServers ?? []) {
      servers[descriptor.name] = toClaudeMcpEntry(descriptor);
    }
  }
  return servers;
}

// Reconcile the Mate-managed Claude settings shape (hooks, permissions, MCP
// servers) on top of whatever already exists in the settings document. Managed
// groups/entries always lead their arrays so the emitted shape stays stable
// across syncs; unmanaged content is preserved untouched.
export function renderManagedClaudeSettings(
  existing: ClaudeSettings,
  companionPath: string,
  config: FrameworkConfig,
  contributions: CapabilityContributionInput[] = [],
): ClaudeSettings {
  // Declared markers and permission entries widen the managed strip set for
  // every registered Capability, enabled or not, so deselection tears down.
  const declaredMarkers = contributions.flatMap((input) =>
    (input.contributions.hookGroups ?? []).map((hook) => hook.marker),
  );
  const declaredPermissionEntries = contributions.flatMap(
    (input) => input.contributions.permissionEntries ?? [],
  );
  // Mate's own hooks (artifact-path guard, session banner, archive-finish
  // nudge) ship in the bundled Claude plugin loaded at launch; settings-sync
  // only strips their legacy managed groups (via removeManagedHookGroups) and
  // reconciles the capability hooks that remain settings-delivered.
  const hooks = removeManagedHookGroups(existing, declaredMarkers).hooks ?? {};
  // Declared hook groups are applied after the table-driven blocks so managed
  // groups keep leading their event arrays in the same order as before the
  // capabilities migrated to declarations.
  for (const input of contributions) {
    if (!input.enabled) continue;
    // Reversed so multiple groups of one declaration end up in declared order.
    for (const hook of (input.contributions.hookGroups ?? []).toReversed()) {
      hooks[hook.event] = [hook.group, ...(hooks[hook.event] ?? [])];
    }
  }
  for (const event of Object.keys(hooks)) {
    if (hooks[event].length === 0) delete hooks[event];
  }

  // permissions.allow: preserve unmanaged entries in place, then union the
  // Mate-managed base entries and enabled capability entries. Dropping a
  // capability removes only its managed entry.
  const allManagedPermissionEntries = new Set([
    ...getAllManagedPermissionEntries(companionPath),
    ...declaredPermissionEntries,
  ]);
  const managedAllow = renderManagedClaudePermissionEntries(companionPath, contributions);
  const existingPermissions = existing.permissions ?? {};
  const existingAllow = Array.isArray(existingPermissions.allow) ? existingPermissions.allow : [];
  const nextAllow = [
    ...existingAllow.filter((entry) => !allManagedPermissionEntries.has(entry)),
    ...managedAllow,
  ];
  const permissions: { allow?: string[] } & Record<string, unknown> = { ...existingPermissions };
  if (nextAllow.length > 0) {
    permissions.allow = nextAllow;
  } else {
    delete permissions.allow;
  }

  const mcpServers = { ...existing.mcpServers };
  // tokensave (and any future Mate-managed MCP server) now lives in the
  // companion `.mcp.json`, loaded via `--mcp-config`. Ensure any legacy inline
  // entry is removed so it cannot shadow the `.mcp.json` definition.
  delete mcpServers.tokensave;

  const settings: ClaudeSettings = { ...existing, hooks, autoMemoryEnabled: false };
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }
  if (Object.keys(permissions).length > 0) {
    settings.permissions = permissions;
  } else {
    delete settings.permissions;
  }
  if (Object.keys(mcpServers).length > 0) {
    settings.mcpServers = mcpServers;
  } else {
    delete settings.mcpServers;
  }

  return settings;
}

// Write the Mate-managed Claude settings into the companion repo. This is the
// config surface Mate owns and loads at launch via `--settings`, so hooks,
// permissions, and MCP servers no longer need to live in the working repo.
export async function syncCompanionClaudeSettings(
  companionPath: string,
  config: FrameworkConfig,
  contributions: CapabilityContributionInput[] = [],
): Promise<void> {
  const settingsPath = getCompanionClaudeSettingsPath(companionPath);
  const existing = await readClaudeSettings(settingsPath);
  const settings = renderManagedClaudeSettings(existing, companionPath, config, contributions);

  await writeClaudeSettings(settingsPath, settings);

  await syncCompanionClaudeMcpConfig(companionPath);
}

// ---------------------------------------------------------------------------
// Runtime Surface reconciliation: apply/remove declared Capability
// contributions (spec: runtime-surface). Managed identity uses the existing
// marker scheme — hook markers, permission-entry membership, managed guidance
// blocks, and named skill trees / MCP servers.
// ---------------------------------------------------------------------------

export async function reconcileClaudeContributions(
  ctx: SetupContext,
  inputs: CapabilityContributionInput[],
): Promise<void> {
  /** Resolved once per pass; every write site below is relative to it. */
  const root = surfaceRoot(ctx);
  const { config } = ctx;

  if (ctx.scope === "hub") {
    await reconcileClaudeMcpContributions(root, inputs);
    await reconcileClaudeAgentDefinitionContributions(root, inputs);
    return;
  }

  // The settings sync (re)creates the managed settings document, so it only
  // runs while the Claude runtime is active; a deactivated runtime's pass is
  // teardown-only and must not resurrect files the provider teardown removed.
  if (ctx.activeProviders.includes("claude")) {
    await syncCompanionClaudeSettings(root, config, inputs);
  }

  await reconcileClaudeMcpContributions(root, inputs);
  await reconcileClaudeAgentDefinitionContributions(root, inputs);

  for (const input of inputs) {
    // Guidance sections are managed blocks in CLAUDE.md. Current sections are
    // upserted, then stale keys (content changes, disabled capability) are
    // swept. CLAUDE.md is Claude-exclusive, so no shared-file guard applies.
    const guidancePath = path.join(root, "CLAUDE.md");
    const sections = input.enabled ? (input.contributions.guidanceSections ?? []) : [];
    const keepKeys = new Set<string>();
    for (const section of sections) {
      const blockKey = instructionBlockKey(input.pluginId, section.content);
      keepKeys.add(blockKey);
      await upsertManagedBlock(guidancePath, FRAMEWORK_NAME, blockKey, section.content);
    }
    if ((input.contributions.guidanceSections ?? []).length > 0) {
      await removeManagedBlocksForPlugin(guidancePath, FRAMEWORK_NAME, input.pluginId, keepKeys);
    }

    for (const skillTree of input.contributions.skillTrees ?? []) {
      const skillDir = path.join(root, ".claude", "skills", skillTree.name);
      if (input.enabled) {
        await mergeDir(skillTree.sourceDir, skillDir);
      } else {
        await fs.rm(skillDir, { recursive: true, force: true });
        await pruneEmptyAncestors(path.join(root, ".claude", "skills"), root);
      }
    }
  }
}

/** Reconcile only MCP entries without touching Claude settings or guidance. */
async function reconcileClaudeMcpContributions(
  root: string,
  inputs: CapabilityContributionInput[],
): Promise<void> {
  for (const input of inputs) {
    for (const descriptor of input.contributions.mcpServers ?? []) {
      await updateClaudeMcpServer(
        getCompanionClaudeMcpConfigPath(root),
        descriptor.name,
        input.enabled ? toClaudeMcpEntry(descriptor) : null,
      );
    }
  }
}

/**
 * Reconcile declared agent definition files under `.claude/agents/`. Runs in
 * both companion and hub scope — an agent definition is fully self-contained
 * (no shared-file merge), so it needs no companion-only surface.
 */
async function reconcileClaudeAgentDefinitionContributions(
  root: string,
  inputs: CapabilityContributionInput[],
): Promise<void> {
  const agentsDir = path.join(root, ".claude", "agents");
  for (const input of inputs) {
    for (const agent of input.contributions.agentDefinitions ?? []) {
      const agentPath = path.join(agentsDir, `${agent.name}.md`);
      if (input.enabled) {
        await fs.mkdir(agentsDir, { recursive: true });
        await fs.writeFile(agentPath, agent.content, "utf8");
      } else {
        await fs.rm(agentPath, { force: true });
        await pruneEmptyAncestors(agentsDir, root);
      }
    }
  }
}

// Maintain the companion `.mcp.json` shell. Managed MCP servers are reconciled
// from declared Capability contributions (and legacy `ctx.mcp` hosting); this
// only guarantees the file exists with an `mcpServers` map. Loaded at launch
// via `claude --mcp-config`.
async function syncCompanionClaudeMcpConfig(companionPath: string): Promise<void> {
  const mcpConfigPath = getCompanionClaudeMcpConfigPath(companionPath);
  const { config: existing } = await readClaudeMcpConfig(mcpConfigPath);
  await writeClaudeMcpConfig(mcpConfigPath, {
    ...existing,
    mcpServers: { ...existing.mcpServers },
  });
}

async function configureClaude(companionPath: string): Promise<void> {
  // Mate hooks are delivered by the bundled Claude plugin at launch; nothing
  // is copied into `companion/.claude/hooks/` anymore. Stale copies from
  // earlier releases are stripped so only the plugin-shipped hooks run.
  await removeLegacyMateHookFiles(companionPath);

  // Note: `.claude/settings.local.json` is now Mate-owned and generated by
  // `syncCompanionClaudeSettings`; do not delete it here. `settings.json` is
  // unmanaged legacy config and is removed so it cannot shadow companion config.
  try {
    await fs.unlink(path.join(companionPath, ".claude", "settings.json"));
  } catch {
    /* not present */
  }

  const agentsMdSrc = path.join(getSetupRootTemplates(), "TEMPLATE_AGENTS.md");
  const agentsMdDest = path.join(companionPath, "AGENTS.md");
  try {
    await fs.access(agentsMdDest);
  } catch {
    await fs.copyFile(agentsMdSrc, agentsMdDest);
  }

  const claudeMdSrc = path.join(getSetupRootTemplates(), "TEMPLATE_CLAUDE.md");
  const claudeMdDest = path.join(companionPath, "CLAUDE.md");
  try {
    await fs.access(claudeMdDest);
  } catch {
    await fs.copyFile(claudeMdSrc, claudeMdDest);
  }
}

async function teardownClaude(companionPath: string, allowedAgents: string[]): Promise<void> {
  // Migration-only: a companion last synced by a pre-plugin release may still
  // carry copied mate hook files.
  await removeLegacyMateHookFiles(companionPath);
  try {
    await fs.unlink(path.join(companionPath, ".claude", "settings.local.json"));
  } catch {
    /* not present */
  }
  try {
    await fs.unlink(path.join(companionPath, ".claude", "settings.json"));
  } catch {
    /* not present */
  }
  try {
    await fs.unlink(getCompanionClaudeMcpConfigPath(companionPath));
  } catch {
    /* not present */
  }
  try {
    await fs.rm(path.join(companionPath, ".claude", "bin"), { recursive: true, force: true });
  } catch {
    /* not present */
  }
  const claudeMdPath = path.join(companionPath, "CLAUDE.md");
  await stripGuidanceBlock(claudeMdPath);
  try {
    const content = await fs.readFile(claudeMdPath, "utf8");
    if (!content.trim()) await fs.unlink(claudeMdPath);
  } catch {
    /* not present */
  }

  const legacyClaudeMdPath = path.join(companionPath, ".claude", "CLAUDE.md");
  await stripGuidanceBlock(legacyClaudeMdPath);
  try {
    const content = await fs.readFile(legacyClaudeMdPath, "utf8");
    if (!content.trim()) await fs.unlink(legacyClaudeMdPath);
  } catch {
    /* not present */
  }
  await pruneEmptyAncestors(path.join(companionPath, ".claude"), companionPath);

  // AGENTS.md is shared with OpenCode. Claude must not remove it while the
  // required OpenCode provider is still active.
  if (!allowedAgents.includes("opencode")) {
    try {
      await fs.unlink(path.join(companionPath, "AGENTS.md"));
    } catch {
      /* not present */
    }
  }
}

async function teardownLegacyClaudeBin(companionPath: string): Promise<void> {
  try {
    await fs.rm(path.join(companionPath, ".claude", "bin"), { recursive: true, force: true });
  } catch {
    /* not present */
  }
  await pruneEmptyAncestors(path.join(companionPath, ".claude"), companionPath);
}

// ---------------------------------------------------------------------------
// Runtime Surface escape hatch (spec: runtime-surface). Imperative operations
// for effects a declaration cannot express — patching skill trees an external
// CLI wrote, absorbing/stripping foreign config another tool produced. Format
// knowledge stays in this module; capabilities pass only predicates.
// ---------------------------------------------------------------------------

/** Patch markdown files of an externally written `.claude/skills/<name>` tree. */
export async function patchClaudeSkillTree(
  companionPath: string,
  name: string,
  transform: (content: string) => string,
  options: { excludeFiles?: readonly string[] } = {},
): Promise<void> {
  await patchSkillTreeMarkdownFiles(
    path.join(companionPath, ".claude", "skills", name),
    transform,
    new Set(options.excludeFiles ?? []),
  );
}

/**
 * Strip a foreign heading section from the Claude guidance surfaces: the
 * companion CLAUDE.md, the legacy `.claude/CLAUDE.md`, and — when syncing from
 * a linked repo — the repo-level CLAUDE.md.
 */
export async function stripClaudeForeignSections(
  companionPath: string,
  options: RemoveHeadingSectionOptions & { repoPath?: string },
): Promise<void> {
  await stripSectionFromFile(path.join(companionPath, "CLAUDE.md"), options);
  await stripSectionFromFile(path.join(companionPath, ".claude", "CLAUDE.md"), options);
  await pruneEmptyAncestors(path.join(companionPath, ".claude"), companionPath);
  if (options.repoPath) {
    await stripSectionFromFile(path.join(options.repoPath, "CLAUDE.md"), options);
  }
}

/**
 * Merge hook groups an external tool wrote to `.claude/settings.json` into the
 * Mate-owned `settings.local.json`, then remove the tracked file so it cannot
 * shadow companion config. Malformed or absent files skip the merge but the
 * `settings.json` removal still happens.
 */
export async function mergeClaudeSettingsJsonHooks(companionPath: string): Promise<void> {
  const settingsJsonPath = path.join(companionPath, ".claude", "settings.json");
  const settingsLocalPath = getCompanionClaudeSettingsPath(companionPath);
  try {
    const settingsJson = JSON.parse(await fs.readFile(settingsJsonPath, "utf8")) as ClaudeSettings;
    const settingsLocal = JSON.parse(
      await fs.readFile(settingsLocalPath, "utf8"),
    ) as ClaudeSettings;

    if (settingsJson.hooks && Object.keys(settingsJson.hooks).length > 0) {
      settingsLocal.hooks = mergeClaudeHookGroups(settingsLocal.hooks ?? {}, settingsJson.hooks);
    }

    await writeClaudeSettings(settingsLocalPath, settingsLocal);
  } catch {
    /* settings files absent or malformed — just remove settings.json */
  }
  try {
    await fs.unlink(settingsJsonPath);
  } catch {
    /* not present */
  }
}

/** Remove settings hook groups matching `isForeign`, pruning emptied containers. */
export async function removeClaudeHookGroupsWhere(
  companionPath: string,
  isForeign: (group: ClaudeHookGroup) => boolean,
): Promise<void> {
  const settingsLocalPath = getCompanionClaudeSettingsPath(companionPath);
  let settings: ClaudeSettings;
  try {
    settings = JSON.parse(await fs.readFile(settingsLocalPath, "utf8")) as ClaudeSettings;
  } catch {
    return; /* settings absent or malformed */
  }

  const existingHooks = settings.hooks ?? {};
  const hooks = filterClaudeHookGroups(existingHooks, (group) => !isForeign(group));
  const changed =
    JSON.stringify(hooks) !== JSON.stringify(existingHooks) ||
    (Object.keys(hooks).length === 0 && Object.prototype.hasOwnProperty.call(settings, "hooks"));
  if (!changed) return;

  if (Object.keys(hooks).length > 0) {
    settings.hooks = hooks;
  } else {
    delete settings.hooks;
  }
  await writeClaudeSettings(settingsLocalPath, settings);
}

export function createClaudePlugin(): ProviderPlugin {
  return {
    id: "claude",
    kind: "provider",
    label: "Claude",
    description: "Install Claude companion files, hooks, and guidance.",
    defaultSelected: true,
    isEnabled: (config) => (config.allowedAgents ?? []).includes("claude"),
    gitignoreEntries: () => COMPANION_GITIGNORE_ENTRIES,
    hosting: {
      mcp: {
        async register(ctx: SetupContext, descriptor) {
          await updateClaudeMcpServer(
            getCompanionClaudeMcpConfigPath(ctx.companionPath),
            descriptor.name,
            toClaudeMcpEntry(descriptor),
          );
        },
        async unregister(ctx: SetupContext, name: string) {
          await updateClaudeMcpServer(
            getCompanionClaudeMcpConfigPath(ctx.companionPath),
            name,
            null,
          );
        },
      },
      instructions: {
        getFilePath: (ctx: SetupContext) => path.join(ctx.companionPath, "CLAUDE.md"),
      },
    },
    async apply(ctx) {
      if (ctx.scope === "hub") {
        await syncCompanionClaudeSettings(ctx.companionPath, ctx.config);
        return;
      }
      await configureClaude(ctx.companionPath);
      await configureClaudeGuidance(ctx.companionPath);
      await teardownLegacyClaudeBin(ctx.companionPath);
      await syncCompanionClaudeSettings(ctx.companionPath, ctx.config);
    },
    async teardown(ctx) {
      await teardownClaude(ctx.companionPath, ctx.config.allowedAgents ?? []);
    },
  };
}
