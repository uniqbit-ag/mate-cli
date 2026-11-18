import { getActiveDistribution } from "../../../distribution";
import { FRAMEWORK_NAME } from "../../../framework";
import { ensureCapabilityEnabled } from "../../../cli/plugin-commands";
import { PLUGIN_API_VERSION, type PluginHost } from "./api";

export { PLUGIN_API_VERSION, type CreatePlugin, type PluginHost } from "./api";

/** Plugin API versions this core can load; v1 is adapted on load and deprecated. */
export const SUPPORTED_PLUGIN_API_VERSIONS: readonly number[] = [1, PLUGIN_API_VERSION];

/** Builds the host bound to the running core instance. */
export function createPluginHost(): PluginHost {
  const distribution = getActiveDistribution();
  return {
    apiVersion: PLUGIN_API_VERSION,
    distribution: {
      name: FRAMEWORK_NAME,
      version: distribution.config.version,
    },
    ensureCapabilityEnabled: (name) => ensureCapabilityEnabled(name),
  };
}
