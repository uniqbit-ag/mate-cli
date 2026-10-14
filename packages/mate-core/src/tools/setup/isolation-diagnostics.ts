// oxlint-disable no-await-in-loop
import path from "node:path";

import type { FrameworkConfig } from "../../lib/orchestrator/types";
import {
  readContributionLedger,
  type ContributionLedger,
  type LedgerIdentities,
} from "./contribution-ledger";
import type { CapabilityPlugin, SetupContext } from "./plugin";
import type { PluginRegistry } from "./registry";
import { managedGuidanceOwners } from "./upgrade-sweep";

/**
 * What `mate doctor` reports about audience isolation: contributions on the
 * companion's persisted surfaces that no base plugin owns, audience plugins
 * the upgrade sweep could not load, and the active audience's plugins whose
 * imperative parts a launch layer cannot deliver.
 */

export interface LeakedContribution {
  /** Companion-relative file or directory. */
  surface: string;
  kind: string;
  /** The entry's name; absent where the surface entry is the owner's block. */
  identity?: string;
  owner: string;
}

export interface UndeliveredAudiencePlugin {
  pluginId: string;
  /** `apply`, `teardown`, `forProvider` or `pluginReferences`. */
  parts: string[];
}

export interface AudienceIsolationReport {
  leaked: LeakedContribution[];
  unswept: string[];
  undelivered: UndeliveredAudiencePlugin[];
}

/** Ledger kinds by where each runtime keeps them; guidance is read from the files themselves. */
const LEDGER_SURFACES: Record<string, Partial<Record<keyof LedgerIdentities, string>>> = {
  claude: {
    mcpServers: ".mcp.json",
    skillTrees: path.join(".claude", "skills"),
    agentDefinitions: path.join(".claude", "agents"),
    hookMarkers: path.join(".claude", "settings.local.json"),
    permissionEntries: path.join(".claude", "settings.local.json"),
  },
  opencode: {
    mcpServers: path.join(".opencode", "opencode.json"),
    pluginReferences: path.join(".opencode", "opencode.json"),
    skillTrees: path.join(".agents", "skills"),
    agentDefinitions: path.join(".opencode", "agents"),
  },
};

function leakedLedgerContributions(
  ledger: ContributionLedger | null,
  baseIds: ReadonlySet<string>,
): LeakedContribution[] {
  const leaked: LeakedContribution[] = [];
  for (const [runtimeId, owners] of Object.entries(ledger?.runtimes ?? {})) {
    for (const [owner, identities] of Object.entries(owners)) {
      if (baseIds.has(owner)) continue;
      for (const [kind, surface] of Object.entries(LEDGER_SURFACES[runtimeId] ?? {})) {
        for (const identity of identities[kind as keyof LedgerIdentities] ?? []) {
          leaked.push({ surface: surface!, kind, identity, owner });
        }
      }
    }
  }
  return leaked;
}

/**
 * Whether a lifecycle hook does anything. `apply` and `teardown` are required
 * members, so a declarative plugin carries empty ones; only a body counts.
 */
function hasBody(hook: unknown): boolean {
  if (typeof hook !== "function") return false;
  const source = Function.prototype.toString.call(hook);
  const open = source.indexOf("{");
  const close = source.lastIndexOf("}");
  if (open === -1 || close <= open) return true;
  const body = source
    .slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
    .trim();
  return body.length > 0;
}

async function undeliveredParts(plugin: CapabilityPlugin, ctx: SetupContext): Promise<string[]> {
  const parts: string[] = [];
  if (hasBody(plugin.apply)) parts.push("apply");
  if (hasBody(plugin.teardown)) parts.push("teardown");
  if (plugin.forProvider && Object.keys(plugin.forProvider).length > 0) parts.push("forProvider");
  try {
    const byRuntime = (await plugin.getRuntimeContributions?.(ctx)) ?? {};
    if (Object.values(byRuntime).some((runtime) => (runtime?.pluginReferences ?? []).length > 0)) {
      parts.push("pluginReferences");
    }
  } catch {
    /** A plugin whose declarations fail is the plugin checks' finding, not this one. */
  }
  return parts;
}

export async function inspectAudienceIsolation(
  companionPath: string,
  config: FrameworkConfig,
  registry: PluginRegistry,
  activeAudience: string | null,
): Promise<AudienceIsolationReport> {
  const baseIds = new Set(registry.baseRegistrations().map((entry) => entry.plugin.id));
  const leaked: LeakedContribution[] = [];

  for (const [surface, owners] of await managedGuidanceOwners(companionPath)) {
    for (const owner of owners) {
      if (!baseIds.has(owner)) leaked.push({ surface, kind: "guidance", owner });
    }
  }

  const ledger = await readContributionLedger(companionPath);
  leaked.push(...leakedLedgerContributions(ledger, baseIds));

  const undelivered: UndeliveredAudiencePlugin[] = [];
  if (activeAudience) {
    const ctx: SetupContext = { companionPath, config, mode: "sync", activeProviders: [] };
    for (const { plugin } of registry.audienceRegistrations(activeAudience)) {
      if (plugin.kind !== "capability") continue;
      const parts = await undeliveredParts(plugin as CapabilityPlugin, ctx);
      if (parts.length > 0) undelivered.push({ pluginId: plugin.id, parts });
    }
  }

  return { leaked, unswept: ledger?.unswept ?? [], undelivered };
}
