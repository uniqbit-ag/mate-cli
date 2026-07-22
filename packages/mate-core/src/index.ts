/**
 * @uniqbit/mate-core — framework entry point.
 *
 * EXPERIMENTAL: the distribution/extension API (createMate, Plugin,
 * SetupContext, plugin registration entries) may change in any release until
 * it is declared stable.
 */
export { createMate, type CreateMateOptions, type MateCli } from "./create-mate";
export {
  getActiveDistribution,
  resetActiveDistribution,
  setActiveDistribution,
  setFallbackDistribution,
  type ActiveDistribution,
  type DistributionConfig,
} from "./distribution";
export {
  normalizeRegistration,
  PluginRegistry,
  type NormalizedRegistration,
} from "./tools/setup/registry";
export type {
  CapabilityPlugin,
  InstructionsService,
  McpServerDescriptor,
  McpService,
  Plugin,
  PluginPolicy,
  PluginRegistration,
  ProviderHosting,
  ProviderPlugin,
  SetupContext,
  TemplatesService,
} from "./tools/setup/plugin";
export type { FrameworkConfig } from "./lib/orchestrator/types";
