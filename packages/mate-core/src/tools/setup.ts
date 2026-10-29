// oxlint-disable no-await-in-loop
import path from "node:path";

import { FRAMEWORK_NAME } from "../framework";
import { ConfigStore, mergeWithDefaults } from "../lib/orchestrator/config-store";
import { GlobalConfigStore } from "../lib/orchestrator/global-config-store";
import {
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
import { getClaudePluginRoot } from "../lib/package-paths";
import type { RenderedRuntimeDocuments } from "../runtime/runtime-document-manifest";
import {
  collectManagedGitignoreEntries,
  writeManagedGitignoreBlock,
} from "./setup/plugins/gitignore";
import { createManagedOutputCollector } from "./setup/managed-output";
import type {
  ManagedOutputReport,
  PluginRegistration,
  SetupContext,
  SetupScope,
} from "./setup/plugin";
import {
  inspectClaudePluginFolders,
  type ClaudePluginContributionFailure,
  type ClaudePluginDirectoryReport,
  type ClaudePluginFolders,
} from "./setup/providers/claude-plugin-folders";
import { getActiveDistribution } from "../distribution";
import { createUvPlugin } from "./setup/package-managers/uv";
import type { PackageManagerSetupDeps } from "./setup/package-managers/uv";
import { applyRequiredSelectionsToConfig } from "./setup/policy";
import { invalidateInstallState } from "../lib/install";
import {
  describeUnknownAudience,
  installPluginDeclarations,
  readAudienceSelection,
  resolveAudience,
} from "./setup/dynamic-plugins/audiences";
import { hydrateDynamicPlugins } from "./setup/dynamic-plugins/hydrate";
import { installDeclaredPlugins } from "./setup/dynamic-plugins/install";
import {
  buildSetupInstallationPlan,
  collectRuntimeContributionInputs,
  executeSetupInstallationPlan,
  publishRuntimeClaudePluginMarketplaces,
  renderRuntimeDocuments,
  type SetupInstallationOutcome,
  type SetupInstallationPlan,
} from "./setup/engine";

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

export interface CompanionSyncOptions {
  /** Regenerates OpenSpec CLI output; set only by `mate companion update`. */
  regenerateOpenSpec?: boolean;
}

export interface CompanionSyncOutcome extends SetupInstallationOutcome {
  /** The managed output this pass wrote or removed. */
  managedOutput: ManagedOutputReport;
}

export async function applySetupCompatibilities(
  companionPath: string,
  config: FrameworkConfig,
  mode: "setup" | "sync",
  plugins: PluginRegistration[] = getActiveDistribution().registry.getEntries(),
  repoPath?: string,
  scope: SetupScope = config.type === "hub" ? "hub" : "companion",
  options: CompanionSyncOptions = {},
): Promise<CompanionSyncOutcome> {
  const plan = buildSetupInstallationPlan(config, plugins);
  const activeProviders = plan.activeProviders;
  const managedOutput = createManagedOutputCollector(companionPath);
  const ctx: SetupContext = {
    companionPath,
    config,
    mode,
    activeProviders,
    repoPath,
    scope,
    ...(options.regenerateOpenSpec ? { regenerateOpenSpec: true } : {}),
    managedOutput: managedOutput.recorder,
  };
  const outcome = await executeSetupInstallationPlan(ctx, plugins, plan);
  return { ...outcome, managedOutput: managedOutput.report() };
}

/**
 * The active Agent Runtimes' documents for a Working Repository, rendered
 * without a write. Runs no plugin phase: the working target reconciles
 * declarations only, so nothing is written to the companion on its behalf.
 */
export async function renderWorkingRuntimeDocuments(
  companionPath: string,
  config: FrameworkConfig,
  repoPath: string,
  plugins: PluginRegistration[] = getActiveDistribution().registry.getAll(),
): Promise<RenderedRuntimeDocuments> {
  const { plan, ctx } = planSyncPass(companionPath, config, plugins, {
    repoPath,
    target: "working",
  });
  return renderRuntimeDocuments(ctx, plugins, plan);
}

/**
 * Publishes the enabled Claude plugin folders for a Working Repository's wrap
 * pass, before it renders; see {@link publishRuntimeClaudePluginMarketplaces}.
 */
export async function publishWorkingClaudePluginMarketplaces(
  companionPath: string,
  config: FrameworkConfig,
  repoPath: string,
  plugins: PluginRegistration[] = getActiveDistribution().registry.getAll(),
): Promise<ClaudePluginFolders> {
  const { plan, ctx } = planSyncPass(companionPath, config, plugins, {
    repoPath,
    target: "working",
  });
  return publishRuntimeClaudePluginMarketplaces(ctx, plugins, plan);
}

/** A sync pass's plan and context, for a caller that runs no plugin phase. */
function planSyncPass(
  companionPath: string,
  config: FrameworkConfig,
  plugins: PluginRegistration[],
  extra: Pick<SetupContext, "repoPath" | "target"> = {},
): { plan: SetupInstallationPlan; ctx: SetupContext } {
  const plan = buildSetupInstallationPlan(config, plugins);
  const ctx: SetupContext = {
    companionPath,
    config,
    mode: "sync",
    activeProviders: plan.activeProviders,
    ...extra,
  };
  return { plan, ctx };
}

/** What an operator sees of the enabled Capabilities' Claude plugin folders. */
export interface ClaudePluginDirectoryInspection {
  plugins: ClaudePluginDirectoryReport[];
  /** Capabilities whose contributions rejected; the other Capabilities are still listed. */
  failures: ClaudePluginContributionFailure[];
}

/**
 * Enabled Capabilities' declared Claude plugin folders and whether `mate claude`
 * passes each, checked against the running install's bundled plugin. Read-only:
 * runs no plugin phase and reconciles nothing.
 */
export async function inspectClaudePluginDirectories(
  companionPath: string,
  config: FrameworkConfig,
  plugins: PluginRegistration[] = getActiveDistribution().registry.getEntries(),
): Promise<ClaudePluginDirectoryInspection> {
  const { plan, ctx } = planSyncPass(companionPath, config, plugins);
  const failures: ClaudePluginContributionFailure[] = [];
  const inputs = await collectRuntimeContributionInputs(ctx, plugins, plan, (capability, error) =>
    failures.push({
      capability,
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  return {
    plugins: [
      ...(
        await inspectClaudePluginFolders(inputs.get("claude") ?? [], {
          bundledPluginRoot: getClaudePluginRoot(),
        })
      ).report,
    ],
    failures,
  };
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

export interface CompanionSyncResult {
  /** For a launch to pass and report; every other caller ignores them. */
  claudePluginFolders: ClaudePluginFolders;
  /** For `mate companion update` to sort changed paths; a launch ignores it. */
  managedOutput: ManagedOutputReport;
}

export async function syncCompanionFiles(
  companionPath: string,
  config: FrameworkConfig,
  repoPath?: string,
  options: CompanionSyncOptions = {},
): Promise<CompanionSyncResult> {
  const outcome = await applySetupCompatibilities(
    companionPath,
    config,
    "sync",
    getActiveDistribution().registry.getAll(),
    repoPath,
    undefined,
    options,
  );
  return { claudePluginFolders: outcome.claudePluginFolders, managedOutput: outcome.managedOutput };
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
  const audience = resolveAudience(config, readAudienceSelection(process.env));
  if (!audience.ok) throw new ConfigError(describeUnknownAudience(audience));
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
  const declarations = installPluginDeclarations(config);
  if (declarations.length) {
    for (const result of await installDeclaredPlugins(companionPath, declarations)) {
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
