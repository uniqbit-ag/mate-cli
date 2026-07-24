// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { getWrapperBinPath } from "../../../lib/package-paths";
import type { FrameworkConfig } from "../../../lib/orchestrator/types";
import { refreshFromTemplate, stripGuidanceBlock } from "../plugins/guidance";
import { TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES } from "../capabilities/tokensave-shared";
import type { McpServerDescriptor, ProviderPlugin, SetupContext } from "../plugin";
import { resolveGitInfoExcludePath } from "../git-utils";
import { mergeDir, pruneEmptyAncestors, resolveCommandOnPath } from "../utils";
import { getSetupProvidersRoot, getSetupRootTemplates } from "./utils";

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

const BASE_WORKING_REPO_LOCAL_EXCLUDE_ENTRIES = [".claude/settings.local.json"];
const COMPANION_GITIGNORE_ENTRIES = [...BASE_WORKING_REPO_LOCAL_EXCLUDE_ENTRIES, ".claude/state/"];
// Union of all managed exclude entries — used to identify which lines we own.
const ALL_MANAGED_EXCLUDE_ENTRIES = new Set([
  ...BASE_WORKING_REPO_LOCAL_EXCLUDE_ENTRIES,
  ...TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES,
]);

// Command substrings that mark a working-repo hook group as Mate-managed.
const MANAGED_HOOK_MARKERS = [
  "validate-artifact-path",
  "mate-session-banner",
  "react-doctor.sh",
  "mate-openspec-artifact-finish.sh",
  "tokensave",
];

// Base `permissions.allow` entries that Claude gets for Mate-managed workflows.
// Read/Glob are scoped to the companion path so routine reads of skills,
// specs, and change artifacts don't prompt for approval on every file.
function getBaseManagedPermissionEntries(companionPath: string): string[] {
  return ["Bash(mate:*)", `Read(${companionPath}/**)`, `Glob(${companionPath}/**)`];
}

const LEGACY_MANAGED_PERMISSION_ENTRIES = [
  "Bash($MATE_COMPANION_BIN_PATH/openspec:*)",
  "Bash($MATE_COMPANION_BIN_PATH/graphify:*)",
];

// Enabled capability -> the `permissions.allow` entries it pre-seeds.
function getCapabilityPermissionEntries(): Record<string, string[]> {
  const wrapperBinPath = getWrapperBinPath();
  return {
    openspec: [
      "Skill(openspec-explore)",
      "Skill(openspec-propose)",
      "Skill(openspec-apply-change)",
      "Skill(openspec-archive-change)",
      "Skill(mate-openspec-artifact-finish)",
      "Bash(openspec:*)",
      "Bash(mate cap graphify:*)",
      `Bash(${path.join(wrapperBinPath, "openspec")}:*)`,
    ],
    headroom: ["Bash(rtk:*)"],
    graphify: [
      "Skill(graphify)",
      "Bash(graphify:*)",
      "Bash(mate cap graphify:*)",
      `Bash(${path.join(wrapperBinPath, "graphify")}:*)`,
    ],
    "react-doctor": [
      "Skill(react-doctor)",
      "Bash(npx react-doctor:*)",
      "Bash(npx react-doctor@latest *)",
    ],
    tokensave: ["mcp__tokensave__*"],
  };
}

function getAllManagedPermissionEntries(companionPath: string): Set<string> {
  return new Set([
    ...getBaseManagedPermissionEntries(companionPath),
    ...Object.values(getCapabilityPermissionEntries()).flat(),
    ...LEGACY_MANAGED_PERMISSION_ENTRIES,
  ]);
}

interface HookCommand {
  type?: string;
  command?: string;
  args?: string[];
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
}
interface WorkingRepoSettings {
  hooks?: Record<string, HookGroup[]>;
  permissions?: { additionalDirectories?: string[]; allow?: string[] } & Record<string, unknown>;
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
  [key: string]: unknown;
}

function isManagedHookGroup(group: HookGroup): boolean {
  return (group.hooks ?? []).some((hook) =>
    MANAGED_HOOK_MARKERS.some((marker) => (hook.command ?? "").includes(marker)),
  );
}

function removeManagedHookGroups(settings: WorkingRepoSettings): WorkingRepoSettings {
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const remainingGroups = (groups ?? []).filter((group) => !isManagedHookGroup(group));
    if (remainingGroups.length > 0) {
      hooks[event] = remainingGroups;
    }
  }

  const next = { ...settings };
  if (Object.keys(hooks).length > 0) {
    next.hooks = hooks;
  } else {
    delete next.hooks;
  }
  return next;
}

async function readWorkingRepoSettings(settingsPath: string): Promise<WorkingRepoSettings> {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as WorkingRepoSettings;
    }
  } catch {
    // Absent or unparseable — start from an empty object.
  }
  return {};
}

export async function ensureWorkingRepoLocalExcludes(
  workingRepoPath: string,
  config: FrameworkConfig,
): Promise<void> {
  const excludePath = await resolveGitInfoExcludePath(workingRepoPath);
  if (!excludePath) {
    return;
  }

  const tokensaveEnabled = (config.capabilities ?? []).some((c) => c.name === "tokensave");
  const desiredEntries = new Set([
    ...BASE_WORKING_REPO_LOCAL_EXCLUDE_ENTRIES,
    ...(tokensaveEnabled ? TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES : []),
  ]);

  let existing = "";
  try {
    existing = await fs.readFile(excludePath, "utf8");
  } catch {
    // Fresh repos may not have created info/exclude yet.
  }

  const lines = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // Reconcile: keep non-managed lines, add desired managed entries, remove undesired.
  const nextLines = lines.filter((line) => !ALL_MANAGED_EXCLUDE_ENTRIES.has(line));
  for (const entry of desiredEntries) {
    if (!nextLines.includes(entry)) {
      nextLines.push(entry);
    }
  }

  const nextContent = nextLines.length > 0 ? nextLines.join("\n") + "\n" : "";
  if (nextContent === existing) {
    return;
  }

  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, nextContent, "utf8");
}

// Marker that identifies the tokensave installer's CLAUDE.md append block.
const TOKENSAVE_CLAUDE_MD_MARKER = "## MANDATORY: No Explore Agents When Tokensave Is Available";

async function stripTokensaveClaudeMdAppend(workingRepoPath: string): Promise<void> {
  const claudeMdPath = path.join(workingRepoPath, "CLAUDE.md");
  let content: string;
  try {
    content = await fs.readFile(claudeMdPath, "utf8");
  } catch {
    return;
  }

  const idx = content.indexOf(TOKENSAVE_CLAUDE_MD_MARKER);
  if (idx === -1) return;

  // Cut from the marker to EOF. Trim trailing whitespace before the cut point.
  const before = content.slice(0, idx).replace(/\s+$/, "");
  if (before.length > 0) {
    await fs.writeFile(claudeMdPath, before + "\n", "utf8");
  } else {
    await fs.unlink(claudeMdPath);
  }
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

// Reconcile the Mate-managed Claude settings shape (hooks, permissions, MCP
// servers) on top of whatever already exists in the settings document. Managed
// groups/entries always lead their arrays so the emitted shape stays stable
// across syncs; unmanaged content is preserved untouched.
function buildManagedClaudeSettings(
  existing: WorkingRepoSettings,
  companionPath: string,
  config: FrameworkConfig,
  tokensaveCommandPath: string,
): WorkingRepoSettings {
  const capabilities = config.capabilities ?? [];
  const enabledNames = new Set(capabilities.map((c) => c.name));
  const openspecEnabled = enabledNames.has("openspec") && config.git === "auto";
  const reactDoctorEnabled = enabledNames.has("react-doctor");

  const hooks = removeManagedHookGroups(existing).hooks ?? {};
  hooks.PreToolUse = [
    {
      matcher: "Write|Edit|MultiEdit|Bash",
      hooks: [
        { type: "command", command: `${companionPath}/.claude/hooks/validate-artifact-path` },
      ],
    },
    ...(hooks.PreToolUse ?? []),
  ];
  hooks.SessionStart = [
    {
      hooks: [{ type: "command", command: `${companionPath}/.claude/hooks/mate-session-banner` }],
    },
    ...(hooks.SessionStart ?? []),
  ];
  if (openspecEnabled) {
    hooks.PostToolUse = [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: `sh "${companionPath}/.claude/hooks/mate-openspec-artifact-finish.sh"`,
          },
        ],
      },
      ...(hooks.PostToolUse ?? []),
    ];
    // End-of-turn catch-all: an archive created by anything other than a matched Bash
    // command (or as the last action of a turn) still gets a finish nudge on Stop.
    hooks.Stop = [
      {
        hooks: [
          {
            type: "command",
            command: `sh "${companionPath}/.claude/hooks/mate-openspec-artifact-finish.sh"`,
            timeout: 10,
          },
        ],
      },
      ...(hooks.Stop ?? []),
    ];
  }
  if (reactDoctorEnabled) {
    // Record edits cheaply, then scan once when the edited turn finishes.
    hooks.PostToolUse = [
      {
        matcher: "Write|Edit|MultiEdit|NotebookEdit|ApplyPatch",
        hooks: [
          {
            type: "command",
            command: `sh "${companionPath}/.claude/hooks/react-doctor.sh"`,
            timeout: 5,
          },
        ],
      },
      ...(hooks.PostToolUse ?? []),
    ];
    hooks.Stop = [
      {
        hooks: [
          {
            type: "command",
            command: `sh "${companionPath}/.claude/hooks/react-doctor.sh"`,
            timeout: 45,
          },
        ],
      },
      ...(hooks.Stop ?? []),
    ];
  }
  if (enabledNames.has("tokensave")) {
    hooks.PreToolUse = [
      {
        matcher: "Agent|Grep|Bash",
        hooks: [{ type: "command", command: tokensaveCommandPath, args: ["hook-pre-tool-use"] }],
      },
      ...(hooks.PreToolUse ?? []),
    ];
    hooks.UserPromptSubmit = [
      {
        hooks: [{ type: "command", command: tokensaveCommandPath, args: ["hook-prompt-submit"] }],
      },
      ...(hooks.UserPromptSubmit ?? []),
    ];
    hooks.Stop = [
      {
        hooks: [{ type: "command", command: tokensaveCommandPath, args: ["hook-stop"] }],
      },
      ...(hooks.Stop ?? []),
    ];
  }
  for (const event of Object.keys(hooks)) {
    if (hooks[event].length === 0) delete hooks[event];
  }

  // permissions.allow: preserve unmanaged entries in place, then union the
  // Mate-managed base entries and enabled capability entries. Dropping a
  // capability removes only its managed entry.
  const capabilityPermissionEntries = getCapabilityPermissionEntries();
  const allManagedPermissionEntries = getAllManagedPermissionEntries(companionPath);
  const managedAllow = [
    ...getBaseManagedPermissionEntries(companionPath),
    ...Object.entries(capabilityPermissionEntries)
      .filter(([name]) => enabledNames.has(name))
      .flatMap(([, entries]) => entries),
  ];
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

  const settings: WorkingRepoSettings = { ...existing, hooks, autoMemoryEnabled: false };
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
): Promise<void> {
  const tokensaveCommandPath =
    resolveCommandOnPath("tokensave", process.env.PATH ?? "") ?? "tokensave";

  const settingsPath = getCompanionClaudeSettingsPath(companionPath);
  const existing = await readWorkingRepoSettings(settingsPath);
  const settings = buildManagedClaudeSettings(
    existing,
    companionPath,
    config,
    tokensaveCommandPath,
  );

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

  await syncCompanionClaudeMcpConfig(companionPath, config);
}

// Maintain the companion `.mcp.json` shell. MCP servers are registered by
// capabilities through `ctx.mcp` (provider hosting) now; this only prunes the
// legacy `tokensave` entry written by releases that predate the bookkeeping
// manifest when the capability is disabled. Loaded at launch via
// `claude --mcp-config`.
async function syncCompanionClaudeMcpConfig(
  companionPath: string,
  config: FrameworkConfig,
): Promise<void> {
  const enabledNames = new Set((config.capabilities ?? []).map((c) => c.name));
  const mcpConfigPath = getCompanionClaudeMcpConfigPath(companionPath);

  let existing: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(mcpConfigPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") {
      existing = parsed as typeof existing;
    }
  } catch {
    // Absent or unparseable — start from an empty object.
  }

  const mcpServers: Record<string, unknown> = { ...existing.mcpServers };
  if (!enabledNames.has("tokensave")) {
    delete mcpServers.tokensave;
  }

  const next = { ...existing, mcpServers };
  await fs.writeFile(mcpConfigPath, JSON.stringify(next, null, 2) + "\n", "utf8");
}

// Reconcile the working repo for a Claude launch. Mate-managed Claude settings
// now live in companion settings (see `syncCompanionClaudeSettings`) and are
// loaded at launch via `--settings`, so Mate no longer writes them into the
// working repo. Existing Mate-managed hooks are removed during migration;
// user-authored settings remain in place. This also keeps the git exclude for
// that file current and strips the TokenSave CLAUDE.md append the installer may
// have added.
export async function syncWorkingRepoClaudeSettings(
  workingRepoPath: string,
  companionPath: string,
  config: FrameworkConfig,
  globalConfigStore = new GlobalConfigStore(),
): Promise<void> {
  await ensureWorkingRepoLocalExcludes(workingRepoPath, config);
  await syncWorkingRepoClaudeAdditionalDirectories(
    workingRepoPath,
    companionPath,
    globalConfigStore,
  );
  await stripTokensaveClaudeMdAppend(workingRepoPath);
}

async function syncWorkingRepoClaudeAdditionalDirectories(
  workingRepoPath: string,
  companionPath: string,
  globalConfigStore: GlobalConfigStore,
): Promise<void> {
  const settingsPath = path.join(workingRepoPath, ".claude", "settings.local.json");
  // Migrate hooks only. Existing permissions and MCP entries stay in the
  // working repo; additionalDirectories is reconciled below.
  const existing = removeManagedHookGroups(await readWorkingRepoSettings(settingsPath));
  const permissions = { ...existing.permissions };
  const existingAdditionalDirectories = Array.isArray(permissions.additionalDirectories)
    ? permissions.additionalDirectories
    : [];
  const registeredCompanionPaths = new Set(
    (await globalConfigStore.list()).map((registeredCompanionPath) =>
      path.resolve(registeredCompanionPath),
    ),
  );
  const resolvedCompanionPath = path.resolve(companionPath);
  const additionalDirectories = Array.from(
    new Set(
      existingAdditionalDirectories
        .map((directory) => path.resolve(directory))
        .filter(
          (directory) =>
            !registeredCompanionPaths.has(directory) || directory === resolvedCompanionPath,
        )
        .concat(resolvedCompanionPath),
    ),
  );

  const settings: WorkingRepoSettings = {
    ...existing,
    permissions: {
      ...permissions,
      additionalDirectories,
    },
  };

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

async function configureClaude(src: string, companionPath: string): Promise<void> {
  await mergeDir(path.join(src, ".claude"), path.join(companionPath, ".claude"));

  // Note: `.claude/settings.local.json` is now Mate-owned and generated by
  // `syncCompanionClaudeSettings`; do not delete it here. `settings.json` is
  // unmanaged legacy config and is removed so it cannot shadow companion config.
  try {
    await fs.unlink(path.join(companionPath, ".claude", "settings.json"));
  } catch {
    /* not present */
  }

  const hooksDir = path.join(companionPath, ".claude", "hooks");
  try {
    const entries = await fs.readdir(hooksDir);
    for (const entry of entries) {
      await fs.chmod(path.join(hooksDir, entry), 0o755);
    }
  } catch {
    // hooks dir may not exist if no hooks are defined
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

async function teardownClaude(companionPath: string, _allowedAgents: string[]): Promise<void> {
  try {
    await fs.unlink(path.join(companionPath, ".claude", "hooks", "validate-artifact-path"));
  } catch {
    /* not present */
  }
  try {
    await fs.unlink(path.join(companionPath, ".claude", "hooks", "mate-session-banner"));
  } catch {
    /* not present */
  }
  await pruneEmptyAncestors(path.join(companionPath, ".claude", "hooks"), companionPath);
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

  try {
    await fs.unlink(path.join(companionPath, "AGENTS.md"));
  } catch {
    /* not present */
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

// Reconcile a single Mate-managed server entry in the companion `.mcp.json`
// while preserving every unrelated entry. `entry: null` removes the server.
async function updateCompanionClaudeMcpServer(
  companionPath: string,
  name: string,
  entry: Record<string, unknown> | null,
): Promise<void> {
  const mcpConfigPath = getCompanionClaudeMcpConfigPath(companionPath);
  let existing: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  let present = false;
  try {
    const parsed = JSON.parse(await fs.readFile(mcpConfigPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") {
      existing = parsed as typeof existing;
      present = true;
    }
  } catch {
    // Absent or unparseable — start from an empty object.
  }
  if (entry === null && !present) return;

  const mcpServers: Record<string, unknown> = { ...existing.mcpServers };
  if (entry === null) {
    if (!(name in mcpServers)) return;
    delete mcpServers[name];
  } else {
    mcpServers[name] = entry;
  }
  await fs.writeFile(
    mcpConfigPath,
    JSON.stringify({ ...existing, mcpServers }, null, 2) + "\n",
    "utf8",
  );
}

function claudeMcpEntry(descriptor: McpServerDescriptor): Record<string, unknown> {
  if (descriptor.url) return { url: descriptor.url };
  return {
    command: descriptor.command,
    ...(descriptor.args ? { args: descriptor.args } : {}),
    ...(descriptor.env ? { env: descriptor.env } : {}),
  };
}

export function createClaudePlugin(): ProviderPlugin {
  return {
    id: "claude",
    kind: "provider",
    label: "Claude",
    description: "Install Claude companion files, hooks, and guidance.",
    defaultSelected: true,
    isEnabled: (config) => (config.profiles.default?.allowedAgents ?? []).includes("claude"),
    gitignoreEntries: () => COMPANION_GITIGNORE_ENTRIES,
    hosting: {
      mcp: {
        async register(ctx: SetupContext, descriptor: McpServerDescriptor) {
          await updateCompanionClaudeMcpServer(
            ctx.companionPath,
            descriptor.name,
            claudeMcpEntry(descriptor),
          );
        },
        async unregister(ctx: SetupContext, name: string) {
          await updateCompanionClaudeMcpServer(ctx.companionPath, name, null);
        },
      },
      instructions: {
        getFilePath: (ctx: SetupContext) => path.join(ctx.companionPath, "CLAUDE.md"),
      },
    },
    async apply(ctx) {
      await configureClaude(path.join(getSetupProvidersRoot(), "claude"), ctx.companionPath);
      await configureClaudeGuidance(ctx.companionPath);
      await teardownLegacyClaudeBin(ctx.companionPath);
      await syncCompanionClaudeSettings(ctx.companionPath, ctx.config);
    },
    async teardown(ctx) {
      await teardownClaude(ctx.companionPath, ctx.config.profiles.default?.allowedAgents ?? []);
    },
  };
}
