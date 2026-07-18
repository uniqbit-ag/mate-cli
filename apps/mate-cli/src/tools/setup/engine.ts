import type { FrameworkConfig } from "../../lib/orchestrator/types";
import type { CapabilityPlugin, Plugin, SetupContext } from "./plugin";

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
  plugins: Plugin[],
): SetupInstallationPlan {
  const activeProviders = plugins
    .filter((plugin) => plugin.kind === "provider" && plugin.isEnabled(config))
    .map((plugin) => plugin.id);
  const activePackageManagers = config.packageManagers ?? ["bun"];
  const actions: SetupInstallationPlanAction[] = [];

  for (const phase of [
    "provider",
    "packageManager",
    "capability",
    "integration",
    "root",
  ] as const) {
    for (const plugin of plugins.filter((candidate) => candidate.kind === phase)) {
      if (phase === "root") {
        actions.push({ phase, pluginId: plugin.id, action: "apply" });
        continue;
      }

      if (phase !== "capability") {
        actions.push({
          phase,
          pluginId: plugin.id,
          action: plugin.isEnabled(config) ? "apply" : "teardown",
        });
        continue;
      }

      const capability = plugin as CapabilityPlugin;
      const missingRequirement = capability.requires?.packageManagers.find(
        (packageManager) => !activePackageManagers.includes(packageManager),
      );
      const enabled = plugin.isEnabled(config) && missingRequirement === undefined;

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
  plugins: Plugin[],
  plan: SetupInstallationPlan,
): Promise<SetupInstallationOutcome> {
  const pluginById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const executedActions: SetupInstallationPlanAction[] = [];
  const skippedActions: SetupInstallationPlanAction[] = [];
  const warnings: string[] = [];

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

    if (action.providerId) {
      const capability = plugin as CapabilityPlugin;
      const handler = capability.forProvider?.[action.providerId];
      if (!handler) {
        continue;
      }
      await handler[action.action](ctx);
      executedActions.push(action);
      continue;
    }

    await plugin[action.action](ctx);
    executedActions.push(action);
  }

  return { executedActions, skippedActions, warnings };
}
