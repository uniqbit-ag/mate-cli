import { getActiveDistribution } from "../../distribution";
import type { FrameworkConfig } from "../../lib/orchestrator/types";
import { collectHostingProviders, ContextServiceMediator } from "./context-services";
import type { CapabilityPlugin, Plugin, PluginRegistration, SetupContext } from "./plugin";
import { normalizeRegistration, type NormalizedRegistration } from "./registry";

export interface SetupInstallationPlanAction {
  phase: Plugin["kind"];
  pluginId: string;
  action: "apply" | "teardown";
  providerId?: string;
  skipReason?: string;
}

export interface SetupInstallationPlan {
  activeProviders: string[];
  actions: SetupInstallationPlanAction[];
}

export interface SetupInstallationOutcome {
  executedActions: SetupInstallationPlanAction[];
  skippedActions: SetupInstallationPlanAction[];
  warnings: string[];
}

export function buildSetupInstallationPlan(
  config: FrameworkConfig,
  registrations: PluginRegistration[],
): SetupInstallationPlan {
  const entries = registrations.map(normalizeRegistration);
  // Required plugins are always treated as enabled: saved selections cannot
  // deselect them and deselection never produces a teardown action.
  const isEntryEnabled = (entry: NormalizedRegistration) =>
    entry.policy === "required" || entry.plugin.isEnabled(config);

  const activeProviders = entries
    .filter((entry) => entry.plugin.kind === "provider" && isEntryEnabled(entry))
    .map((entry) => entry.plugin.id);
  const activePackageManagers = config.packageManagers ?? ["bun"];
  const actions: SetupInstallationPlanAction[] = [];

  for (const phase of [
    "provider",
    "packageManager",
    "capability",
    "integration",
    "root",
  ] as const) {
    for (const entry of entries.filter((candidate) => candidate.plugin.kind === phase)) {
      const plugin = entry.plugin;
      if (phase === "root") {
        actions.push({ phase, pluginId: plugin.id, action: "apply" });
        continue;
      }

      if (phase !== "capability") {
        actions.push({
          phase,
          pluginId: plugin.id,
          action: isEntryEnabled(entry) ? "apply" : "teardown",
        });
        continue;
      }

      const capability = plugin as CapabilityPlugin;
      const missingRequirement = capability.requires?.packageManagers.find(
        (packageManager) => !activePackageManagers.includes(packageManager),
      );
      const enabled = isEntryEnabled(entry) && missingRequirement === undefined;

      actions.push({
        phase,
        pluginId: plugin.id,
        action: enabled ? "apply" : "teardown",
        skipReason:
          missingRequirement === undefined
            ? undefined
            : `requires ${missingRequirement} package manager`,
      });

      for (const providerId of Object.keys(capability.forProvider ?? {})) {
        actions.push({
          phase,
          pluginId: plugin.id,
          providerId,
          action: enabled && activeProviders.includes(providerId) ? "apply" : "teardown",
        });
      }
    }
  }

  return { activeProviders, actions };
}

export async function executeSetupInstallationPlan(
  ctx: SetupContext,
  registrations: PluginRegistration[],
  plan: SetupInstallationPlan,
): Promise<SetupInstallationOutcome> {
  const plugins = registrations.map((entry) => normalizeRegistration(entry).plugin);
  const pluginById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const executedActions: SetupInstallationPlanAction[] = [];
  const skippedActions: SetupInstallationPlanAction[] = [];
  const warnings: string[] = [];

  const distribution = getActiveDistribution();
  const mediator = new ContextServiceMediator({
    ctx,
    frameworkName: distribution.config.name,
    hostingProviders: collectHostingProviders(plugins, plan.activeProviders),
    assetOverrideRoots: distribution.config.assetRoots,
    warn: (message) => {
      warnings.push(message);
      process.stderr.write(`${message}\n`);
    },
  });

  for (const action of plan.actions) {
    const plugin = pluginById.get(action.pluginId);
    if (!plugin) {
      continue;
    }

    if (action.skipReason) {
      skippedActions.push(action);
      const warning = `${action.pluginId} capability disabled: ${action.skipReason}`;
      warnings.push(warning);
      process.stderr.write(`${warning}\n`);
    }

    // Track every planned plugin so bookkeeping reconciles entries the plugin
    // no longer registers (including all of them on teardown).
    mediator.track(action.pluginId);
    const actionCtx: SetupContext = { ...ctx, ...mediator.servicesFor(action.pluginId) };

    if (action.providerId) {
      const capability = plugin as CapabilityPlugin;
      const handler = capability.forProvider?.[action.providerId];
      if (!handler) {
        continue;
      }
      await handler[action.action](actionCtx);
      executedActions.push(action);
      continue;
    }

    await plugin[action.action](actionCtx);
    executedActions.push(action);
  }

  await mediator.finalize();

  return { executedActions, skippedActions, warnings };
}
