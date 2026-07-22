import { getActiveDistribution } from "../../distribution";
import type { SetupSelections } from "../../lib/orchestrator/setup-compatibilities";
import type { FrameworkConfig } from "../../lib/orchestrator/types";
import type { Plugin } from "./plugin";

/** Ids of plugins the active distribution registers with policy "required". */
export function getRequiredPluginIds(): Set<string> {
  return new Set(
    getActiveDistribution()
      .registry.getEntries()
      .filter((entry) => entry.policy === "required")
      .map((entry) => entry.plugin.id),
  );
}

function requiredPluginsByKind(): { plugin: Plugin }[] {
  return getActiveDistribution()
    .registry.getEntries()
    .filter((entry) => entry.policy === "required");
}

/**
 * Union required plugins into a selection set. Explicit-flag and wizard flows
 * persist required plugins even when the operator's input omits them.
 */
export function withRequiredSelections(selections: SetupSelections): SetupSelections {
  const allowedAgents = new Set(selections.allowedAgents);
  const packageManagers = new Set(selections.packageManagers);
  const capabilities = [...selections.capabilities];

  for (const { plugin } of requiredPluginsByKind()) {
    if (plugin.kind === "provider") allowedAgents.add(plugin.id);
    if (plugin.kind === "packageManager") packageManagers.add(plugin.id);
    if (plugin.kind === "capability" && !capabilities.some((c) => c.name === plugin.id)) {
      capabilities.push({ name: plugin.id });
    }
  }

  return {
    ...selections,
    allowedAgents: [...allowedAgents],
    packageManagers: [...packageManagers],
    capabilities,
  };
}

export interface RequiredPluginDrift {
  pluginId: string;
  kind: Plugin["kind"];
  reason: string;
}

/**
 * Report required plugins missing from a companion's effective setup state.
 * Root plugins always apply, so only selectable kinds can drift.
 */
export function getRequiredPluginDrift(config: FrameworkConfig): RequiredPluginDrift[] {
  const drift: RequiredPluginDrift[] = [];
  for (const { plugin } of requiredPluginsByKind()) {
    if (
      plugin.kind === "provider" &&
      !(config.profiles.default?.allowedAgents ?? []).includes(plugin.id)
    ) {
      drift.push({
        pluginId: plugin.id,
        kind: plugin.kind,
        reason: "required provider is missing from the allowed agents",
      });
    }
    // Same effective default as the engine: a missing key means ["bun"].
    if (
      plugin.kind === "packageManager" &&
      !(config.packageManagers ?? ["bun"]).includes(plugin.id)
    ) {
      drift.push({
        pluginId: plugin.id,
        kind: plugin.kind,
        reason: "required package manager is missing from the configuration",
      });
    }
    if (
      plugin.kind === "capability" &&
      !(config.capabilities ?? []).some((c) => c.name === plugin.id)
    ) {
      drift.push({
        pluginId: plugin.id,
        kind: plugin.kind,
        reason: "required capability is missing from the configuration",
      });
    }
  }
  return drift;
}

/** Ensure a companion config carries every required plugin before it is saved. */
export function applyRequiredSelectionsToConfig(config: FrameworkConfig): void {
  for (const { plugin } of requiredPluginsByKind()) {
    if (plugin.kind === "provider") {
      const profile = config.profiles.default;
      if (profile && !profile.allowedAgents.includes(plugin.id)) {
        profile.allowedAgents.push(plugin.id);
      }
    }
    if (plugin.kind === "packageManager") {
      const packageManagers = config.packageManagers ?? [];
      if (!packageManagers.includes(plugin.id)) {
        config.packageManagers = [...packageManagers, plugin.id];
      }
    }
    if (plugin.kind === "capability") {
      const capabilities = config.capabilities ?? [];
      if (!capabilities.some((c) => c.name === plugin.id)) {
        config.capabilities = [...capabilities, { name: plugin.id }];
      }
    }
  }
}
