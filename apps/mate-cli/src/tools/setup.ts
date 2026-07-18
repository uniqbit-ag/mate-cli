// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import { frameworkConfig } from "../framework";
import { ConfigStore, mergeWithDefaults } from "../lib/orchestrator/config-store";
import { GlobalConfigStore } from "../lib/orchestrator/global-config-store";
import {
  BUILTIN_SETUP_COMPATIBILITIES,
  dedupeCapabilities,
  getSetupSelectionsFromConfig,
} from "../lib/orchestrator/setup-compatibilities";
import {
  formatSetupGuardrailError,
  inspectSetupPreflight,
} from "../lib/orchestrator/setup-preflight";
import type { FrameworkTool } from "../lib/orchestrator/tool";
import {
  ConfigError,
  type CapabilityConfig,
  type FrameworkConfig,
} from "../lib/orchestrator/types";
import { syncWorkingRepoClaudeSettings } from "./setup/providers/claude";
import {
  collectManagedGitignoreEntries,
  writeManagedGitignoreBlock,
} from "./setup/plugins/gitignore";
import type { Plugin, SetupContext } from "./setup/plugin";
import { registry } from "./setup/registry";
import { createUvPlugin } from "./setup/package-managers/uv";
import type { PackageManagerSetupDeps } from "./setup/package-managers/uv";
import { invalidateInstallState } from "../lib/install";
import {
  buildSetupInstallationPlan,
  executeSetupInstallationPlan,
  type SetupInstallationOutcome,
} from "./setup/engine";

export { syncWorkingRepoClaudeSettings };

export interface SetupInput {
  allowedAgents?: string[];
  packageManagers?: string[];
  capabilities?: CapabilityConfig[];
  git?: "auto" | "default";
}

export interface SetupDependencies {
  cwd?: string;
  configStore?: ConfigStore;
  globalConfigStore?: GlobalConfigStore;
}

export async function applySetupCompatibilities(
  companionPath: string,
  config: FrameworkConfig,
  mode: "setup" | "sync",
  plugins: Plugin[] = registry.getAll(),
  repoPath?: string,
): Promise<SetupInstallationOutcome> {
  const plan = buildSetupInstallationPlan(config, plugins);
  const activeProviders = plan.activeProviders;
  const ctx: SetupContext = { companionPath, config, mode, activeProviders, repoPath };
  return executeSetupInstallationPlan(ctx, plugins, plan);
}

export async function updateProjectGitignore(
  companionPath: string,
  config: FrameworkConfig,
): Promise<void> {
  const ctx: SetupContext = { companionPath, config, mode: "sync", activeProviders: [] };
  const plugins = registry.getAll();
  const entries = collectManagedGitignoreEntries(ctx, plugins);
  await writeManagedGitignoreBlock(
    path.join(companionPath, ".gitignore"),
    frameworkConfig.name,
    entries,
  );
}

export async function syncCompanionFiles(
  companionPath: string,
  config: FrameworkConfig,
  repoPath?: string,
): Promise<void> {
  await applySetupCompatibilities(companionPath, config, "sync", registry.getAll(), repoPath);
}

function mateFolderReadme(): string {
  const n = frameworkConfig.name;
  return [
    `# .${n}`,
    ``,
    `This directory is managed by the **${n}** companion framework (\`@uniqbit/${n}\`).`,
    ``,
    `The ${n} framework keeps your AI agent's companion artifacts separate from the code it works on.`,
    `Specs, notes, and agent config live here; code stays in the linked working repository.`,
    ``,
    `## Common commands`,
    ``,
    `| Command | Description |`,
    `|---|---|`,
    `| \`${n} companion setup\` | Initialize or re-configure this companion |`,
    `| \`${n} companion link\` | Link a working repository to a companion |`,
    `| \`${n} companion list\` | List linked repositories for the active working repo context |`,
    `| \`${n} companion open\` | Inject the resolved companion into the current editor window |`,
    `| \`${n} claude\` / \`${n} opencode\` | Launch an allowed agent from a linked working repository |`,
    `| \`${n} doctor\` | Check current link state, installed tools, and active capabilities |`,
    ``,
    `Run \`${n} claude\` or \`${n} opencode\` from any linked working repository directory.`,
    ``,
    `## Configuration`,
    ``,
    `Edit \`.${n}/config/framework.yaml\` to configure:`,
    ``,
    `- **profiles** — per-profile allowed agents list`,
    `- **capabilities** — skill and CLI tool capabilities (e.g. react-doctor, openspec, tokensave, headroom)`,
    `- **git** — set to \`auto\` to synchronize the companion before agent launches`,
    ``,
  ].join("\n");
}

async function writeMateReadme(companionPath: string): Promise<void> {
  const readmePath = path.join(companionPath, `.${frameworkConfig.name}`, "README.md");
  await fs.mkdir(path.dirname(readmePath), { recursive: true });
  await fs.writeFile(readmePath, mateFolderReadme(), "utf8");
}

export const setupToolDeps = {
  executeSetup: (input: SetupInput) => executeSetup(input),
};

const setup: FrameworkTool<SetupInput, { config: FrameworkConfig }> = {
  name: "setup",
  description: "Initialize framework runtime, default profiles, and configure .opencode.",
  async execute(input) {
    return setupToolDeps.executeSetup(input);
  },
};

export async function executeSetup(
  input: SetupInput,
  deps: SetupDependencies = {},
): Promise<{ config: FrameworkConfig }> {
  const cwd = path.resolve(deps.cwd ?? process.cwd());
  const globalConfigStore = deps.globalConfigStore ?? new GlobalConfigStore();
  const preflight = await inspectSetupPreflight(cwd, globalConfigStore);
  if (preflight.kind === "linked-working-repo") {
    throw new ConfigError(formatSetupGuardrailError(cwd, preflight.match));
  }

  const configStore =
    deps.configStore ??
    new ConfigStore(path.join(cwd, `.${frameworkConfig.name}`, "config", "framework.yaml"));
  const config = mergeWithDefaults(await configStore.load());
  const defaultProfile = config.profiles.default;

  if (input.allowedAgents !== undefined) {
    defaultProfile.allowedAgents = [...new Set(input.allowedAgents)];
  }
  if (input.packageManagers !== undefined) {
    config.packageManagers = getSetupSelectionsFromConfig({
      ...config,
      packageManagers: input.packageManagers,
    }).packageManagers;
  }
  if (input.capabilities !== undefined) {
    config.capabilities = dedupeCapabilities(input.capabilities);
  }
  if (input.git === "auto") config.git = "auto";
  if (input.git === "default") delete config.git;
  await configStore.save(config);

  const companionPath = path.resolve(cwd);
  await applySetupCompatibilities(companionPath, config, "setup");
  await invalidateInstallState({ kind: "companion", companionPath });

  await globalConfigStore.register(companionPath);

  await writeMateReadme(companionPath);

  // Setup no longer fans out to linked repos: capabilities that touch a working repo
  // (companion files on launch, the tokensave/graphify graph via `mate cap index`)
  // are applied in that repo's own context, not eagerly from here.
  return { config };
}

// Exported for tests — allows injecting deps into the uv plugin for unit testing.
// Auto-confirms install prompts so tests do not block on interactive input.
export function createUvPluginForTest(deps: PackageManagerSetupDeps) {
  return createUvPlugin({ confirm: async () => true, ...deps });
}

export default setup;

// Re-export BUILTIN_SETUP_COMPATIBILITIES passthrough for setup-selector UI compatibility.
export { BUILTIN_SETUP_COMPATIBILITIES };
