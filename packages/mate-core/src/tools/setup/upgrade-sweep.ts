// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { removeManagedBlocksForPlugin } from "./context-services";
import {
  audiencePluginDeclarations,
  declaredAudiences,
  effectivePluginDeclarations,
  readFrameworkRaw,
} from "./dynamic-plugins/audiences";
import { validateDeclaration } from "./dynamic-plugins/declarations";
import { loadDynamicPlugin, type DynamicPluginLoadDeps } from "./dynamic-plugins/loader";
import type { CapabilityContributionInput, CapabilityPlugin, Plugin, SetupContext } from "./plugin";
import type { NormalizedRegistration } from "./registry";

/**
 * Upgrade Sweep: removes what audience plugins leaked into a companion before
 * the contribution ledger existed. Runs once, when a persisted pass finds no
 * ledger, and again only for the packages it could not load then.
 */

/** The companion files Mate's managed guidance blocks live in. */
const GUIDANCE_FILES = ["CLAUDE.md", "AGENTS.md", path.join(".opencode", "AGENTS.md")];

const MANAGED_BLOCK_START = new RegExp(
  `<!-- ${FRAMEWORK_NAME}:managed:([^\\n]+):[0-9a-f]+ start -->`,
  "g",
);

/** Plugin ids owning a managed guidance block in `text`. */
export function managedBlockOwners(text: string): string[] {
  return [...new Set([...text.matchAll(MANAGED_BLOCK_START)].map((match) => match[1]!))];
}

/** `relative path → owners` for every managed guidance block under `root`. */
export async function managedGuidanceOwners(root: string): Promise<Map<string, string[]>> {
  const owners = new Map<string, string[]>();
  for (const file of GUIDANCE_FILES) {
    const text = await fs.readFile(path.join(root, file), "utf8").catch(() => null);
    if (text === null) continue;
    const found = managedBlockOwners(text);
    if (found.length > 0) owners.set(file, found);
  }
  return owners;
}

/**
 * Guidance blocks name their owner, so this needs no plugin loaded: every
 * block whose owner is not a base registration goes.
 */
export async function removeForeignGuidanceBlocks(
  root: string,
  baseIds: ReadonlySet<string>,
): Promise<void> {
  for (const [file, owners] of await managedGuidanceOwners(root)) {
    for (const owner of owners) {
      if (baseIds.has(owner)) continue;
      await removeManagedBlocksForPlugin(path.join(root, file), FRAMEWORK_NAME, owner);
    }
  }
}

export interface AudienceSweep {
  /** Disabled inputs for every swept plugin, per runtime. */
  teardown: Map<string, CapabilityContributionInput[]>;
  /** Packages that could not be loaded; their non-guidance entries stay until a retry. */
  unswept: string[];
  warnings: string[];
}

export interface AudienceSweepOptions {
  /** Every registration of the process; an audience plugin already loaded is reused, not reloaded. */
  registrations: readonly NormalizedRegistration[];
  /** Restrict the sweep to these packages; every audience declaration when absent. */
  packages?: ReadonlySet<string>;
  deps?: DynamicPluginLoadDeps;
}

/** One distinct package per audience declaration, base packages excluded. */
function audiencePackages(raw: unknown): Map<string, ReturnType<typeof validateDeclaration>> {
  const basePackages = new Set(
    effectivePluginDeclarations(raw, null).flatMap((entry) => {
      const { declaration } = validateDeclaration(entry);
      return declaration ? [declaration.package] : [];
    }),
  );
  const found = new Map<string, ReturnType<typeof validateDeclaration>>();
  for (const audience of declaredAudiences(raw)) {
    for (const entry of audiencePluginDeclarations(raw, audience)) {
      const validated = validateDeclaration(entry);
      const name = validated.declaration?.package;
      if (!name || basePackages.has(name) || found.has(name)) continue;
      found.set(name, validated);
    }
  }
  return found;
}

/**
 * Collects the declarations of every audience plugin as disabled inputs:
 * loaded for its declarations only — never activated, no lifecycle hook run.
 * An unloadable plugin is reported, never fatal.
 */
export async function sweepAudienceDeclarations(
  ctx: SetupContext,
  options: AudienceSweepOptions,
): Promise<AudienceSweep> {
  const sweep: AudienceSweep = { teardown: new Map(), unswept: [], warnings: [] };
  const raw = await readFrameworkRaw(ctx.companionPath);

  for (const [name, { declaration }] of audiencePackages(raw)) {
    if (options.packages && !options.packages.has(name)) continue;
    let plugin: Plugin | undefined = options.registrations.find(
      (entry) => entry.packageName === name,
    )?.plugin;
    if (!plugin) {
      const loaded = await loadDynamicPlugin(ctx.companionPath, declaration!, options.deps);
      if (!loaded.ok) {
        sweep.unswept.push(name);
        sweep.warnings.push(
          `audience plugin "${name}" was not swept from the companion: ${loaded.warning} Its entries stay until a pass can load it.`,
        );
        continue;
      }
      plugin = loaded.plugin;
    }

    const capability = plugin as CapabilityPlugin;
    if (plugin.kind !== "capability" || !capability.getRuntimeContributions) continue;
    try {
      const byRuntime = await capability.getRuntimeContributions(ctx);
      for (const [runtimeId, contributions] of Object.entries(byRuntime)) {
        if (!contributions) continue;
        const inputs = sweep.teardown.get(runtimeId) ?? [];
        inputs.push({
          pluginId: plugin.id,
          enabled: false,
          capabilityEnabled: false,
          contributions,
        });
        sweep.teardown.set(runtimeId, inputs);
      }
    } catch (error) {
      sweep.unswept.push(name);
      sweep.warnings.push(
        `audience plugin "${name}" was not swept from the companion: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return sweep;
}
