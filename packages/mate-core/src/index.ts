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
  type DistributionUpdateConfig,
} from "./distribution";
export {
  normalizeRegistration,
  PluginRegistry,
  type NormalizedRegistration,
} from "./tools/setup/registry";
export { ensureCapabilityEnabled, type EnsureCapabilityEnabledDeps } from "./cli/plugin-commands";
// Dynamic plugin authors: import from this package as TYPES ONLY. Runtime
// imports resolve a second, uninitialized copy of mate-core inside the
// plugin's own node_modules; all runtime behavior flows through PluginHost.
export {
  createPluginHost,
  PLUGIN_API_VERSION,
  SUPPORTED_PLUGIN_API_VERSIONS,
  type CreatePlugin,
  type PluginHost,
} from "./tools/setup/dynamic-plugins/host";
export type {
  CapabilityPlugin,
  InstructionsService,
  LaunchPreflightContext,
  McpServerDescriptor,
  McpService,
  Plugin,
  PluginCliCommand,
  PluginPolicy,
  PluginRegistration,
  ProviderHosting,
  ProviderPlugin,
  SetupContext,
  TemplatesService,
} from "./tools/setup/plugin";
export type {
  FrameworkType,
  FrameworkConfig,
  HubConfig,
  HubMember,
  HubMemberSource,
  PluginDeclaration,
  PluginDeclarationPolicy,
} from "./lib/orchestrator/types";
export {
  defaultSessionEnvelopeDeps,
  resolveSessionEnvelope,
  SESSION_ENVELOPE_RESOLUTION_SCHEMA_VERSION,
  SESSION_ENVELOPE_SCHEMA_VERSION,
  type SessionEnvelope,
  type SessionEnvelopeCandidate,
  type SessionEnvelopeDeps,
  type SessionEnvelopeDiagnostic,
  type SessionEnvelopeDiagnosticCode,
  type SessionEnvelopeRequest,
  type SessionEnvelopeResolution,
  type SessionEnvelopeSelection,
} from "./lib/orchestrator/session-envelope";
