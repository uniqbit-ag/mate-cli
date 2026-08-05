// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import {
  OPENCODE_PLUGIN_PACKAGE_NAME,
  getOpenCodePluginPackageReference,
  isMateOpenCodePluginReference,
  warmOpenCodePluginCache,
} from "../../../lib/opencode-plugin-package";
import { refreshFromTemplate, stripGuidanceBlock } from "../plugins/guidance";
import { stripSectionFromFile, type RemoveHeadingSectionOptions } from "./agent-file-sections";
import { patchSkillTreeMarkdownFiles } from "./skill-tree";
import {
  instructionBlockKey,
  removeManagedBlocksForPlugin,
  upsertManagedBlock,
} from "../context-services";
import type { CapabilityContributionInput, ProviderPlugin, SetupContext } from "../plugin";
import { mergeDir, pruneEmptyAncestors } from "../utils";
import {
  getOpenCodePluginReferences,
  isRecord,
  readOpenCodeConfig,
  setOpenCodePluginReferences,
  toOpenCodeMcpEntry,
  updateOpenCodeMcpServer,
  writeOpenCodeConfig,
  type OpenCodeConfig,
} from "./opencode-format";
import { getSetupProvidersRoot, getSetupRootTemplates } from "./utils";

// Copied Mate plugin source files from earlier releases. Plugin code is
// package-owned now; these exact filenames are removed during sync and
// teardown while every other companion-local plugin is preserved.
const LEGACY_PLUGIN_FILES = [
  "add-dir.ts",
  "companion.ts",
  "small-model.ts",
  "companion-policy.ts",
  "mate-small-model.ts",
  "mate-add-dir.ts",
  "mate-companion.ts",
  "mate-companion-policy.ts",
  "mate-companion-hooks.ts",
  "mate-companion-tui.tsx",
  "mate-session-banner.ts",
  "mate-session-banner.tsx",
];
// Plugin-array entries older setups wrote for copied Mate plugin files.
const LEGACY_PLUGIN_CONFIG_ENTRY_PATTERN = /(?:^|\/)plugins\/mate-[^/]+\.(?:ts|tsx)$/;
// Companion-local runtime files earlier releases materialized. Guidance is
// delivered through the MATE_GUIDANCE_JSON launch environment now, and with
// no copied files left to track the sync manifest is obsolete too.
const LEGACY_RUNTIME_FILES = [".mate-guidance.json", ".mate-runtime.json"];
// OpenTUI dependencies earlier releases injected into the companion-local
// package.json. The plugin package owns its runtime dependencies now; these
// exact pins are removed during migration while user-managed entries stay.
const LEGACY_TUI_DEPENDENCIES = {
  "@opentui/core": "^0.3.4",
  "@opentui/keymap": "^0.3.4",
  "@opentui/solid": "^0.3.4",
};

function mergeConfigDefaults(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>,
): void {
  for (const [key, defaultValue] of Object.entries(defaults)) {
    const existingValue = target[key];

    if (Array.isArray(defaultValue)) {
      if (existingValue === undefined) {
        target[key] = [...defaultValue];
        continue;
      }

      if (Array.isArray(existingValue)) {
        for (const item of defaultValue) {
          if (!existingValue.includes(item)) {
            existingValue.push(item);
          }
        }
      }
      continue;
    }

    if (isRecord(defaultValue)) {
      if (existingValue === undefined) {
        target[key] = structuredClone(defaultValue);
        continue;
      }

      if (isRecord(existingValue)) {
        mergeConfigDefaults(existingValue, defaultValue);
      }
      continue;
    }

    if (existingValue === undefined) {
      target[key] = defaultValue;
    }
  }
}

function isLegacyMatePluginConfigEntry(entry: unknown): boolean {
  return typeof entry === "string" && LEGACY_PLUGIN_CONFIG_ENTRY_PATTERN.test(entry);
}

/**
 * Replace any Mate plugin entry (stale package pins and legacy copied-file
 * references) with the current pinned package reference while preserving
 * every unrelated plugin entry.
 */
function ensureMatePluginReference(config: OpenCodeConfig, pluginReference: string): void {
  const preserved = getOpenCodePluginReferences(config).filter(
    (entry) => !isMateOpenCodePluginReference(entry) && !isLegacyMatePluginConfigEntry(entry),
  );
  setOpenCodePluginReferences(config, [...preserved, pluginReference]);
}

function stripMatePluginReference(config: OpenCodeConfig): void {
  if (!Array.isArray(config.plugin)) return;

  const preserved = getOpenCodePluginReferences(config).filter(
    (entry) => !isMateOpenCodePluginReference(entry) && !isLegacyMatePluginConfigEntry(entry),
  );
  setOpenCodePluginReferences(config, preserved);
}

async function syncOpenCodeConfigFile(
  srcPath: string,
  destPath: string,
  pluginReference: string,
): Promise<void> {
  const defaults = JSON.parse(await fs.readFile(srcPath, "utf8")) as Record<string, unknown>;

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(destPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return;
    }
  }

  mergeConfigDefaults(existing, defaults);
  ensureMatePluginReference(existing, pluginReference);
  await writeOpenCodeConfig(destPath, existing);
}

function normalizeForComparison(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForComparison);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, normalizeForComparison(entry)]),
    );
  }
  return value;
}

/**
 * Remove the Mate plugin references from a framework-managed config file.
 * When nothing but the template defaults remains, the file itself is removed;
 * any user-managed content keeps the file in place.
 */
async function teardownOpenCodeConfigFile(srcPath: string, destPath: string): Promise<void> {
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(await fs.readFile(destPath, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }

  stripMatePluginReference(existing);

  let matchesTemplateDefaults = false;
  try {
    const defaults = JSON.parse(await fs.readFile(srcPath, "utf8")) as Record<string, unknown>;
    matchesTemplateDefaults =
      JSON.stringify(normalizeForComparison(existing)) ===
      JSON.stringify(normalizeForComparison(defaults));
  } catch {
    // Missing template: fall through and keep the stripped config file.
  }

  if (matchesTemplateDefaults || Object.keys(existing).length === 0) {
    await fs.unlink(destPath).catch(() => {});
    return;
  }

  await writeOpenCodeConfig(destPath, existing);
}

async function removeLegacyTuiDependencies(dest: string): Promise<void> {
  const packagePath = path.join(dest, "package.json");
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(await fs.readFile(packagePath, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }

  const dependencies = isRecord(existing.dependencies) ? existing.dependencies : undefined;
  if (!dependencies) return;

  let changed = false;
  for (const [name, version] of Object.entries(LEGACY_TUI_DEPENDENCIES)) {
    if (dependencies[name] !== version && dependencies[name] !== version.slice(1)) continue;
    delete dependencies[name];
    changed = true;
  }
  if (!changed) return;

  if (Object.keys(dependencies).length === 0) {
    delete existing.dependencies;
  }
  if (Object.keys(existing).length === 0) {
    await fs.unlink(packagePath).catch(() => {});
    return;
  }
  await fs.writeFile(packagePath, JSON.stringify(existing, null, 2) + "\n", "utf8");
}

async function removeLegacyRuntimeFiles(dest: string): Promise<void> {
  for (const file of LEGACY_RUNTIME_FILES) {
    try {
      await fs.unlink(path.join(dest, file));
    } catch {
      // not present, nothing to do
    }
  }
  for (const file of LEGACY_PLUGIN_FILES) {
    try {
      await fs.unlink(path.join(dest, "plugins", file));
    } catch {
      // not present, nothing to do
    }
  }
}

async function warmPluginCacheForSetup(pluginReference: string): Promise<void> {
  const warmed = await warmOpenCodePluginCache();
  if (warmed.ok) return;

  process.stderr.write(
    [
      `${FRAMEWORK_NAME}: could not pre-fetch ${pluginReference} into OpenCode's plugin environment.`,
      "The first managed OpenCode launch will download it, which requires registry access.",
      `Re-run \`${FRAMEWORK_NAME} companion setup\` with network access to warm the cache ahead of time.`,
      ...(warmed.detail ? [`Details: ${warmed.detail}`] : []),
    ].join("\n") + "\n",
  );
}

async function syncOpenCodeRuntimeFiles(
  src: string,
  companionPath: string,
  mode: SetupContext["mode"],
): Promise<void> {
  const dest = path.join(companionPath, ".opencode");
  await fs.mkdir(dest, { recursive: true });

  const pluginReference = getOpenCodePluginPackageReference();

  await syncOpenCodeConfigFile(
    path.join(src, "opencode.json"),
    path.join(dest, "opencode.json"),
    pluginReference,
  );
  await syncOpenCodeConfigFile(
    path.join(src, "tui.json"),
    path.join(dest, "tui.json"),
    pluginReference,
  );
  await removeLegacyRuntimeFiles(dest);
  await removeLegacyTuiDependencies(dest);

  // Warm OpenCode's plugin package cache only during interactive setup; the
  // lightweight launch-time sync path must not install dependencies.
  if (mode === "setup") {
    await warmPluginCacheForSetup(pluginReference);
  }
}

async function configureOpenCodeGuidance(companionPath: string): Promise<void> {
  await refreshFromTemplate(
    path.join(companionPath, "AGENTS.md"),
    path.join(getSetupRootTemplates(), "TEMPLATE_AGENTS.md"),
  );
}

async function teardownOpenCodeGuidance(
  companionPath: string,
  activeProviders: string[],
): Promise<void> {
  // Claude owns the shared root AGENTS.md whenever it is active.
  if (activeProviders.includes("claude")) return;

  const agentsMdPath = path.join(companionPath, "AGENTS.md");
  await stripGuidanceBlock(agentsMdPath);
  try {
    const content = await fs.readFile(agentsMdPath, "utf8");
    if (!content.trim()) await fs.unlink(agentsMdPath);
  } catch {
    /* not present */
  }
}

async function teardownOpenCode(companionPath: string, activeProviders: string[]): Promise<void> {
  const src = path.join(getSetupProvidersRoot(), "opencode");
  const dest = path.join(companionPath, ".opencode");

  await teardownOpenCodeConfigFile(
    path.join(src, "opencode.json"),
    path.join(dest, "opencode.json"),
  );
  await teardownOpenCodeConfigFile(path.join(src, "tui.json"), path.join(dest, "tui.json"));
  await removeLegacyRuntimeFiles(dest);
  await removeLegacyTuiDependencies(dest);
  await pruneEmptyAncestors(path.join(dest, "plugins"), companionPath);
  await pruneEmptyAncestors(path.join(dest, "skills"), companionPath);
  await pruneEmptyAncestors(dest, companionPath);
  await teardownOpenCodeGuidance(companionPath, activeProviders);
}

function getCompanionOpenCodeConfigPath(companionPath: string): string {
  return path.join(companionPath, ".opencode", "opencode.json");
}

// ---------------------------------------------------------------------------
// Runtime Surface escape hatch (spec: runtime-surface). Imperative operations
// for effects a declaration cannot express. Format knowledge stays here;
// capabilities pass only predicates.
// ---------------------------------------------------------------------------

/** Patch markdown files of an externally written `.opencode/skills/<name>` tree. */
export async function patchOpenCodeSkillTree(
  companionPath: string,
  name: string,
  transform: (content: string) => string,
  options: { excludeFiles?: readonly string[] } = {},
): Promise<void> {
  await patchSkillTreeMarkdownFiles(
    path.join(companionPath, ".opencode", "skills", name),
    transform,
    new Set(options.excludeFiles ?? []),
  );
}

/**
 * Strip a foreign heading section from the OpenCode guidance surfaces: the
 * shared root AGENTS.md, the per-provider `.opencode/AGENTS.md`, and — when
 * syncing from a linked repo — the repo-level AGENTS.md. With
 * `guardSharedFile`, the shared root file is left alone while another active
 * runtime (Claude) still uses it.
 */
export async function stripOpenCodeForeignSections(
  companionPath: string,
  options: RemoveHeadingSectionOptions & {
    repoPath?: string;
    guardSharedFile?: { activeProviders: string[] };
  },
): Promise<void> {
  const sharedWithActive = options.guardSharedFile?.activeProviders.includes("claude") ?? false;
  if (!sharedWithActive) {
    await stripSectionFromFile(path.join(companionPath, "AGENTS.md"), options);
  }
  await stripSectionFromFile(path.join(companionPath, ".opencode", "AGENTS.md"), options);
  if (options.repoPath) {
    await stripSectionFromFile(path.join(options.repoPath, "AGENTS.md"), options);
  }
}

/**
 * Remove plugin entries matching `isForeign` from `opencode.json`. A config
 * left empty is deleted; malformed configs are left untouched.
 */
export async function removeOpenCodeForeignPluginReferences(
  companionPath: string,
  isForeign: (entry: unknown) => boolean,
): Promise<void> {
  const configPath = getCompanionOpenCodeConfigPath(companionPath);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(parsed.plugin)) {
      setOpenCodePluginReferences(
        parsed,
        parsed.plugin.filter((entry) => !isForeign(entry)),
      );
    }
    if (Object.keys(parsed).length === 0) {
      await fs.unlink(configPath);
    } else {
      await writeOpenCodeConfig(configPath, parsed);
    }
  } catch {
    // JSON parse error — leave file untouched
  }
}

// ---------------------------------------------------------------------------
// Runtime Surface reconciliation: apply/remove declared Capability
// contributions (spec: runtime-surface). Managed identity: named MCP servers,
// `isManagedReference` for plugin entries, managed guidance blocks, and named
// skill trees.
// ---------------------------------------------------------------------------

const OPENCODE_CONTRIBUTION_CONFIG_FILES = ["opencode.json", "tui.json"];

export async function reconcileOpenCodeContributions(
  ctx: SetupContext,
  inputs: CapabilityContributionInput[],
): Promise<void> {
  const { companionPath } = ctx;

  if (ctx.scope === "hub") {
    await reconcileOpenCodeMcpContributions(ctx, inputs);
    return;
  }

  await reconcileOpenCodeMcpContributions(ctx, inputs);

  for (const input of inputs) {
    for (const pluginReference of input.contributions.pluginReferences ?? []) {
      const configFiles = pluginReference.configFiles ?? OPENCODE_CONTRIBUTION_CONFIG_FILES;
      for (const name of configFiles) {
        const configPath = path.join(companionPath, ".opencode", name);
        const { present, config } = await readOpenCodeConfig(configPath);
        if (!input.enabled && !present) continue;
        const preserved = getOpenCodePluginReferences(config).filter(
          (entry) => !pluginReference.isManagedReference(entry),
        );
        setOpenCodePluginReferences(
          config,
          input.enabled ? [...preserved, pluginReference.reference] : preserved,
        );
        await writeOpenCodeConfig(configPath, config);
      }
    }

    // Guidance sections are managed blocks in AGENTS.md. Capability disable
    // strips them here; runtime teardown of the shared AGENTS.md is guarded in
    // the provider teardown paths (kept while another active runtime uses it).
    const guidancePath = path.join(companionPath, "AGENTS.md");
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
      const skillDir = path.join(companionPath, ".opencode", "skills", skillTree.name);
      if (input.enabled) {
        await mergeDir(skillTree.sourceDir, skillDir);
      } else {
        await fs.rm(skillDir, { recursive: true, force: true });
        await pruneEmptyAncestors(path.join(companionPath, ".opencode", "skills"), companionPath);
      }
    }
  }
}

/** Reconcile only MCP entries without touching OpenCode plugins or guidance. */
async function reconcileOpenCodeMcpContributions(
  ctx: SetupContext,
  inputs: CapabilityContributionInput[],
): Promise<void> {
  for (const input of inputs) {
    for (const descriptor of input.contributions.mcpServers ?? []) {
      await updateOpenCodeMcpServer(
        getCompanionOpenCodeConfigPath(ctx.companionPath),
        descriptor.name,
        input.enabled ? toOpenCodeMcpEntry(descriptor) : null,
      );
    }
  }
}

export function createOpenCodePlugin(): ProviderPlugin {
  return {
    id: "opencode",
    kind: "provider",
    label: "OpenCode",
    description: "Install the OpenCode plugin workspace.",
    defaultSelected: false,
    isEnabled: (config) => (config.allowedAgents ?? []).includes("opencode"),
    hosting: {
      mcp: {
        async register(ctx: SetupContext, descriptor) {
          await updateOpenCodeMcpServer(
            getCompanionOpenCodeConfigPath(ctx.companionPath),
            descriptor.name,
            toOpenCodeMcpEntry(descriptor),
          );
        },
        async unregister(ctx: SetupContext, name: string) {
          await updateOpenCodeMcpServer(
            getCompanionOpenCodeConfigPath(ctx.companionPath),
            name,
            null,
          );
        },
      },
      instructions: {
        getFilePath: (ctx: SetupContext) => path.join(ctx.companionPath, "AGENTS.md"),
      },
    },
    async apply(ctx: SetupContext) {
      if (ctx.scope === "hub") return;
      await syncOpenCodeRuntimeFiles(
        path.join(getSetupProvidersRoot(), "opencode"),
        ctx.companionPath,
        ctx.mode,
      );
      await configureOpenCodeGuidance(ctx.companionPath);
    },
    async teardown(ctx: SetupContext) {
      await teardownOpenCode(ctx.companionPath, ctx.activeProviders);
    },
  };
}

export { OPENCODE_PLUGIN_PACKAGE_NAME };
