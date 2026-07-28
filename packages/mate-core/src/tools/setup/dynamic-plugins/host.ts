import { getActiveDistribution } from "../../../distribution";
import { ensureCapabilityEnabled } from "../../../cli/plugin-commands";
import type { CapabilityPlugin, Plugin } from "../plugin";

/** Host API version this core constructs. Grows only on breaking changes. */
export const PLUGIN_API_VERSION = 1;

/** Plugin API versions this core can load. */
export const SUPPORTED_PLUGIN_API_VERSIONS: readonly number[] = [PLUGIN_API_VERSION];

/**
 * The sole runtime surface a dynamic plugin receives into the running core.
 *
 * Dynamic plugin packages must not import runtime values from
 * `@uniqbit/mate-core` — a dynamically imported plugin would resolve a second
 * bundled copy whose module-level state was never initialized. Type-only
 * imports are safe (erased at build); all behavior flows through this host.
 * The surface evolves additively within an `apiVersion`.
 */
export interface PluginHost {
  apiVersion: typeof PLUGIN_API_VERSION;
  /** Identity of the running distribution. */
  distribution: { name: string; version: string };
  /**
   * Verifies the named capability is enabled for the active companion,
   * reporting guidance and setting a failing exit code when it is not.
   */
  ensureCapabilityEnabled(name: string): Promise<boolean>;
}

/**
 * The factory a dynamic plugin package exports — as the default export, or as
 * a named `createPlugin` export when no default function exists. Called once
 * per invocation with the plugin's effective config (committed block merged
 * with local overrides, env-interpolated). Config validation is the plugin's
 * responsibility: throw with a descriptive message to reject it.
 */
export type CreatePlugin = (config: unknown, host: PluginHost) => Plugin | CapabilityPlugin;

/** Builds the host bound to the running core instance. */
export function createPluginHost(): PluginHost {
  const distribution = getActiveDistribution();
  return {
    apiVersion: PLUGIN_API_VERSION,
    distribution: {
      name: distribution.config.name,
      version: distribution.config.version,
    },
    ensureCapabilityEnabled: (name) => ensureCapabilityEnabled(name),
  };
}
