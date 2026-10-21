// oxlint-disable no-await-in-loop
import { getActiveDistribution } from "../../distribution";
import { FRAMEWORK_NAME } from "../../framework";
import type { FrameworkConfig } from "../../lib/orchestrator/types";
import type { RenderedRuntimeDocuments } from "../../runtime/runtime-document-manifest";
import { collectHostingProviders, ContextServiceMediator } from "./context-services";
import type {
  CapabilityContributionInput,
  CapabilityPlugin,
  Plugin,
  PluginRegistration,
  SetupContext,
} from "./plugin";
import { reconcileClaudeContributions, renderClaudeWorkingDocuments } from "./providers/claude";
import {
  reconcileOpenCodeContributions,
  renderOpenCodeWorkingDocuments,
} from "./providers/opencode";
import { normalizeRegistration, type NormalizedRegistration } from "./registry";
import { projectionRepoRoot } from "./surface-target";

export type { RenderedRuntimeDocuments };

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
    frameworkName: FRAMEWORK_NAME,
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

    if (ctx.scope === "hub" && action.phase !== "provider") {
      if (action.phase === "capability" && !action.providerId) {
        const capability = plugin as CapabilityPlugin;
        const hubHandler = action.action === "apply" ? capability.applyHub : capability.teardownHub;
        if (hubHandler) {
          mediator.track(action.pluginId);
          const actionCtx: SetupContext = { ...ctx, ...mediator.servicesFor(action.pluginId) };
          await hubHandler(actionCtx);
          executedActions.push(action);
        }
      }
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

  await reconcileCapabilityContributions(ctx, plugins, plan);

  return { executedActions, skippedActions, warnings };
}

// The Runtime Surface of each active Agent Runtime, by runtime id.
const RUNTIME_SURFACE_RECONCILERS: Record<
  string,
  (ctx: SetupContext, inputs: CapabilityContributionInput[]) => Promise<void>
> = {
  claude: reconcileClaudeContributions,
  opencode: reconcileOpenCodeContributions,
};

/**
 * The working-target render of each Runtime Surface, by runtime id, in the
 * order its documents are rendered.
 */
const RUNTIME_SURFACE_WORKING_RENDERERS: Record<
  string,
  (ctx: SetupContext, inputs: CapabilityContributionInput[]) => Promise<RenderedRuntimeDocuments>
> = {
  claude: renderClaudeWorkingDocuments,
  opencode: renderOpenCodeWorkingDocuments,
};

/**
 * The declared Capability contributions of one pass, keyed by runtime. Shared
 * by both targets: what a companion pass writes is what a working pass renders.
 */
async function collectContributionInputs(
  ctx: SetupContext,
  plugins: Plugin[],
  plan: SetupInstallationPlan,
): Promise<Map<string, CapabilityContributionInput[]>> {
  // The plan already resolved enablement (policy, saved selection, package
  // manager requirements); mirror it instead of recomputing.
  const enabledByPluginId = new Map(
    plan.actions
      .filter((action) => action.phase === "capability" && action.providerId === undefined)
      .map((action) => [action.pluginId, action.action === "apply"]),
  );

  const inputsByRuntime = new Map<string, CapabilityContributionInput[]>();
  for (const plugin of plugins) {
    if (plugin.kind !== "capability") continue;
    const capability = plugin as CapabilityPlugin;
    if (!capability.getRuntimeContributions) continue;
    const enabled = enabledByPluginId.get(capability.id) ?? false;
    const byRuntime = await capability.getRuntimeContributions(ctx);
    for (const [runtimeId, contributions] of Object.entries(byRuntime)) {
      if (!contributions) continue;
      // Inactive runtimes still reconcile — with everything disabled — so a
      // deselected runtime's managed entries (skill trees, guidance blocks)
      // are torn down. The surfaces never create files for disabled inputs.
      const runtimeActive = plan.activeProviders.includes(runtimeId);
      const inputs = inputsByRuntime.get(runtimeId) ?? [];
      inputs.push({
        pluginId: capability.id,
        enabled: enabled && runtimeActive,
        capabilityEnabled: enabled,
        contributions,
      });
      inputsByRuntime.set(runtimeId, inputs);
    }
  }
  return inputsByRuntime;
}

/**
 * Reconcile declared Capability contributions through every active runtime's
 * Runtime Surface (spec: plugin-engine). Runs after all plugin phases, so
 * providers are always done first. Disabled capabilities participate with
 * `enabled: false` and drive teardown of their managed entries.
 */
async function reconcileCapabilityContributions(
  ctx: SetupContext,
  plugins: Plugin[],
  plan: SetupInstallationPlan,
): Promise<void> {
  const inputsByRuntime = await collectContributionInputs(ctx, plugins, plan);
  for (const [runtimeId, inputs] of inputsByRuntime) {
    const reconcile = RUNTIME_SURFACE_RECONCILERS[runtimeId];
    if (!reconcile || inputs.length === 0) continue;
    await reconcile(ctx, inputs);
  }
}

/**
 * The same declarations, rendered rather than written: a working-target pass
 * produces the documents and the Projection Root places them, so no Runtime
 * Surface reaches inside a Working Repository. Refuses before anything renders
 * when the context has no Working Repository: every document is addressed by it.
 */
export async function renderRuntimeDocuments(
  ctx: SetupContext,
  registrations: PluginRegistration[],
  plan: SetupInstallationPlan,
): Promise<RenderedRuntimeDocuments> {
  projectionRepoRoot(ctx);
  const plugins = registrations.map((entry) => normalizeRegistration(entry).plugin);
  const inputsByRuntime = await collectContributionInputs(ctx, plugins, plan);
  const rendered: RenderedRuntimeDocuments = { documents: [], warnings: [] };
  for (const [runtimeId, render] of Object.entries(RUNTIME_SURFACE_WORKING_RENDERERS)) {
    if (!ctx.activeProviders.includes(runtimeId)) continue;
    const { documents, warnings } = await render(ctx, inputsByRuntime.get(runtimeId) ?? []);
    rendered.documents.push(...documents);
    rendered.warnings.push(...warnings);
  }
  return rendered;
}
