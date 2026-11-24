/**
 * Types-only plugin API for dynamic plugin packages. Every module this entry
 * reaches must typecheck in a strict consumer project; `plugin-api.test.ts`
 * guards that, so add only type exports from leaf modules.
 */
export type { CreatePlugin, PluginHost } from "./tools/setup/dynamic-plugins/api";
export type {
  CapabilityPlugin,
  HookGroupContribution,
  McpServerDescriptor,
  Plugin,
  PluginCliCommand,
  RuntimeContributions,
  RuntimeContributionsByRuntime,
  SetupContext,
  SetupScope,
} from "./tools/setup/plugin";
export type {
  StudioConnection,
  StudioConnectionProblem,
  StudioConnectionState,
} from "./cli/commands/studio/connection";
export type { ClaudeHookCommand, ClaudeHookGroup } from "./runtime/claude-hook-group";
export type {
  CompanionSourceResult,
  PluginService,
  ServiceApiVersion,
  ServiceCommand,
  ServiceConnection,
  StudioCompanionSnapshot,
  StudioCompanionSource,
  StudioRoute,
  StudioRouteAccess,
  StudioRouteContext,
  StudioRouteMethod,
  StudioServiceContribution,
  StudioServiceHost,
  StudioSocketHandler,
  StudioSocketPeer,
  StudioTerminalHost,
  StudioView,
  StudioViewMount,
  StudioViewMountContext,
  StudioWorksetSessions,
  WorksetSessionCloseReason,
  WorksetSessionResolution,
} from "./tools/setup/service";
