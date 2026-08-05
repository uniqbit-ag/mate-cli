// oxlint-disable no-await-in-loop
import path from "node:path";

import { FRAMEWORK_NAME } from "../framework";
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
import type { PluginRegistration, SetupContext, SetupScope } from "./setup/plugin";
import { getActiveDistribution } from "../distribution";
import { createUvPlugin } from "./setup/package-managers/uv";
import type { PackageManagerSetupDeps } from "./setup/package-managers/uv";
import { applyRequiredSelectionsToConfig } from "./setup/policy";
import { invalidateInstallState } from "../lib/install";
import { hydrateDynamicPlugins } from "./setup/dynamic-plugins/hydrate";
import { installDeclaredPlugins } from "./setup/dynamic-plugins/install";
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
  plugins: PluginRegistration[] = getActiveDistribution().registry.getEntries(),
  repoPath?: string,
  scope: SetupScope = config.type === "hub" ? "hub" : "companion",
): Promise<SetupInstallationOutcome> {
  const plan = buildSetupInstallationPlan(config, plugins);
  const activeProviders = plan.activeProviders;
  const ctx: SetupContext = { companionPath, config, mode, activeProviders, repoPath, scope };
  return executeSetupInstallationPlan(ctx, plugins, plan);
}

export async function updateProjectGitignore(
  companionPath: string,
  config: FrameworkConfig,
): Promise<void> {
  const ctx: SetupContext = { companionPath, config, mode: "sync", activeProviders: [] };
  const plugins = getActiveDistribution().registry.getAll();
  const entries = collectManagedGitignoreEntries(ctx, plugins);
  await writeManagedGitignoreBlock(path.join(companionPath, ".gitignore"), FRAMEWORK_NAME, entries);
}

export async function syncCompanionFiles(
  companionPath: string,
  config: FrameworkConfig,
  repoPath?: string,
): Promise<void> {
  await applySetupCompatibilities(
    companionPath,
    config,
    "sync",
    getActiveDistribution().registry.getAll(),
    repoPath,
  );
}

export const setupToolDeps = {
  executeSetup: (input: SetupInput) => executeSetup(input),
};

const setup: FrameworkTool<SetupInput, { config: FrameworkConfig }> = {
  name: "setup",
  description: "Initialize framework runtime, agent policy, and configure .opencode.",
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
    new ConfigStore(path.join(cwd, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"));
  const config = mergeWithDefaults(await configStore.load());
  if (input.allowedAgents !== undefined) {
    config.allowedAgents = [...new Set(input.allowedAgents)];
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
  // Required plugins are part of the persisted selection even when explicit
  // flags omit them; the wizard locks them, and doctor reports drift.
  applyRequiredSelectionsToConfig(config);
  await configStore.save(config);

  const companionPath = path.resolve(cwd);
  // Declared plugin packages install and hydrate before the setup plan runs,
  // so a fresh clone reaches a fully applied state from one setup run
  // (install → load → plan).
  if (config.plugins?.length) {
    for (const result of await installDeclaredPlugins(companionPath, config.plugins)) {
      if (result.status === "failed") {
        process.stderr.write(
          `${FRAMEWORK_NAME}: plugin "${result.package}" failed to install: ${result.error ?? "unknown error"}\n`,
        );
      }
    }
    await hydrateDynamicPlugins({ companionPath });
  }
  await applySetupCompatibilities(companionPath, config, "setup");
  await invalidateInstallState({
    kind: config.type === "hub" ? "hub" : "companion",
    companionPath,
  });

  await globalConfigStore.register(companionPath);

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
