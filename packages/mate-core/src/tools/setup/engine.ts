// oxlint-disable no-await-in-loop
import { getActiveDistribution } from "../../distribution";
import { FRAMEWORK_NAME } from "../../framework";
import type { FrameworkConfig } from "../../lib/orchestrator/types";
import type { RenderedRuntimeDocument } from "../../runtime/runtime-document-manifest";
import { collectHostingProviders, ContextServiceMediator } from "./context-services";
import {
  ledgerFromInputs,
  ledgerTeardownInput,
  readContributionLedger,
  writeContributionLedger,
  type ContributionLedger,
} from "./contribution-ledger";
import type {
  CapabilityContributionInput,
  CapabilityPlugin,
  Plugin,
  PluginRegistration,
  SetupContext,
} from "./plugin";
import { reconcileClaudeContributions } from "./providers/claude";
import { reconcileOpenCodeContributions } from "./providers/opencode";
import { mergeCompanionOpenCodeConfig, renderDocumentsForTarget } from "./runtime-documents";
import { normalizeRegistration, type NormalizedRegistration } from "./registry";
import { surfaceRoot } from "./surface-target";
import { removeForeignGuidanceBlocks, sweepAudienceDeclarations } from "./upgrade-sweep";

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

/**
 * The registrations a pass that writes a persisted surface may reconcile:
 * base only. An audience registration takes part in no such pass — neither
 * its lifecycle hooks nor its declared contributions — whatever audience is
 * active; its contributions reach sessions only through the launch layer.
 */
export function persistedRegistrations(
  registrations: PluginRegistration[],
): NormalizedRegistration[] {
  return registrations.map(normalizeRegistration).filter((entry) => entry.audience === null);
}

export function buildSetupInstallationPlan(
  config: FrameworkConfig,
  registrations: PluginRegistration[],
): SetupInstallationPlan {
  const entries = persistedRegistrations(registrations);
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
  const plugins = persistedRegistrations(registrations).map((entry) => entry.plugin);
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

  const reconcileWarnings = await reconcileCapabilityContributions(
    ctx,
    plugins,
    plan,
    registrations.map(normalizeRegistration),
  );
  for (const warning of reconcileWarnings) {
    warnings.push(warning);
    process.stderr.write(`${warning}\n`);
  }

  return { executedActions, skippedActions, warnings };
}

// The Runtime Surface of each active Agent Runtime, by runtime id.
export const RUNTIME_SURFACE_RECONCILERS: Record<
  string,
  (ctx: SetupContext, inputs: CapabilityContributionInput[]) => Promise<void>
> = {
  claude: reconcileClaudeContributions,
  opencode: reconcileOpenCodeContributions,
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
  registrations: NormalizedRegistration[],
): Promise<string[]> {
  const inputsByRuntime = await collectContributionInputs(ctx, plugins, plan);
  const ledgerRoot = surfaceRoot(ctx);
  const ledger = await readContributionLedger(ledgerRoot);
  const warnings: string[] = [];
  let unswept = ledger?.unswept ?? [];
  if (!ledger || unswept.length > 0) {
    if (!ledger) {
      await removeForeignGuidanceBlocks(ledgerRoot, new Set(plugins.map((plugin) => plugin.id)));
    }
    const sweep = await sweepAudienceDeclarations(ctx, {
      registrations,
      ...(ledger ? { packages: new Set(unswept) } : {}),
    });
    prependTeardown(inputsByRuntime, sweep.teardown);
    unswept = sweep.unswept;
    warnings.push(...sweep.warnings);
  }
  prependLedgerTeardown(inputsByRuntime, ledger);
  for (const [runtimeId, inputs] of inputsByRuntime) {
    const reconcile = RUNTIME_SURFACE_RECONCILERS[runtimeId];
    if (!reconcile || inputs.length === 0) continue;
    await reconcile(ctx, inputs);
  }
  await writeContributionLedger(ledgerRoot, ledgerFromInputs(inputsByRuntime, unswept));
  return warnings;
}

/**
 * Disabled inputs placed first, skipping any owner that is an enabled input
 * of the pass on that runtime: removal runs before enabled inputs apply.
 */
function prependTeardown(
  inputsByRuntime: Map<string, CapabilityContributionInput[]>,
  teardownByRuntime: ReadonlyMap<string, readonly CapabilityContributionInput[]>,
): void {
  for (const [runtimeId, teardown] of teardownByRuntime) {
    const inputs = inputsByRuntime.get(runtimeId) ?? [];
    const enabled = new Set(inputs.filter((input) => input.enabled).map((input) => input.pluginId));
    const kept = teardown.filter((input) => !enabled.has(input.pluginId));
    if (kept.length > 0) inputsByRuntime.set(runtimeId, [...kept, ...inputs]);
  }
}

/**
 * Every recorded owner that is not an enabled input of this pass, as a
 * disabled input placed first: its entries are removed before enabled inputs
 * apply, so an identity another plugin still declares is re-applied after.
 * Entries the ledger does not record are never named, so they survive.
 */
function prependLedgerTeardown(
  inputsByRuntime: Map<string, CapabilityContributionInput[]>,
  ledger: ContributionLedger | null,
): void {
  prependTeardown(
    inputsByRuntime,
    new Map(
      Object.entries(ledger?.runtimes ?? {}).map(([runtimeId, owners]) => [
        runtimeId,
        Object.entries(owners).map(([owner, identities]) => ledgerTeardownInput(owner, identities)),
      ]),
    ),
  );
}

/**
 * The declared contributions of one audience's plugins, as enabled inputs per
 * active runtime. No plugin phase and no lifecycle hook runs: an audience
 * plugin contributes declaratively only. OpenCode plugin references are
 * dropped — the Mate plugin has no way to load another plugin.
 */
export async function collectAudienceInputs(
  ctx: SetupContext,
  registrations: PluginRegistration[],
  audience: string,
): Promise<Map<string, CapabilityContributionInput[]>> {
  const inputsByRuntime = new Map<string, CapabilityContributionInput[]>();
  for (const entry of registrations.map(normalizeRegistration)) {
    if (entry.audience !== audience || entry.plugin.kind !== "capability") continue;
    const capability = entry.plugin as CapabilityPlugin;
    if (!capability.getRuntimeContributions) continue;
    if (entry.policy !== "required" && !capability.isEnabled(ctx.config)) continue;
    const byRuntime = await capability.getRuntimeContributions(ctx);
    for (const [runtimeId, contributions] of Object.entries(byRuntime)) {
      if (!contributions || !ctx.activeProviders.includes(runtimeId)) continue;
      const { pluginReferences: _dropped, ...declarative } = contributions;
      const inputs = inputsByRuntime.get(runtimeId) ?? [];
      inputs.push({
        pluginId: capability.id,
        enabled: true,
        capabilityEnabled: true,
        contributions: declarative,
      });
      inputsByRuntime.set(runtimeId, inputs);
    }
  }
  return inputsByRuntime;
}

/** What a render returns: its warnings are data for the caller, never printed here. */
export interface RenderedRuntimeDocuments {
  documents: RenderedRuntimeDocument[];
  warnings: string[];
}

/**
 * The same declarations, rendered rather than written: a working-target pass
 * produces the documents and the Projection Root places them, so no Runtime
 * Surface reaches inside a Working Repository.
 */
export async function renderRuntimeDocuments(
  ctx: SetupContext,
  registrations: PluginRegistration[],
  plan: SetupInstallationPlan,
  wrapped?: { audience: string; registrations: PluginRegistration[] },
): Promise<RenderedRuntimeDocuments> {
  const plugins = persistedRegistrations(registrations).map((entry) => entry.plugin);
  const inputsByRuntime = await collectContributionInputs(ctx, plugins, plan);
  /** A checkout wrapped for an audience carries it beside base; no other audience ever. */
  if (wrapped) {
    const audienceInputs = await collectAudienceInputs(
      ctx,
      wrapped.registrations,
      wrapped.audience,
    );
    for (const [runtimeId, inputs] of audienceInputs) {
      inputsByRuntime.set(runtimeId, [...(inputsByRuntime.get(runtimeId) ?? []), ...inputs]);
    }
  }
  const documents = renderDocumentsForTarget(ctx, inputsByRuntime);
  if (ctx.target !== "working") return { documents, warnings: [] };
  return mergeCompanionOpenCodeConfig(ctx.companionPath, documents);
}
