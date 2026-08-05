import type { FrameworkConfig, LinkedRepository } from "../../lib/orchestrator/types";
import type { InstallRequirement, InstallRequirementContext } from "./install-contract";
import type { ClaudeHookGroup } from "./providers/claude-format";

export type SetupScope = "companion" | "hub";

export interface SetupContext {
  companionPath: string;
  config: FrameworkConfig;
  mode: "setup" | "sync";
  activeProviders: string[];
  /** Hub setup runs providers but excludes companion-only surfaces. */
  scope?: SetupScope;
  /** Working repository path when syncing from a linked repo (e.g. during launch). */
  repoPath?: string;
  /**
   * Provider-mediated context services. Always populated when the engine
   * executes a plugin; optional so hand-built contexts (tests, direct calls)
   * remain valid.
   */
  mcp?: McpService;
  instructions?: InstructionsService;
  templates?: TemplatesService;
}

export interface LaunchPreflightContext {
  companionPath: string;
  config: FrameworkConfig;
  repository: LinkedRepository;
  providerId: string;
}

/** Provider-agnostic description of an MCP server to register. */
export interface McpServerDescriptor {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface McpService {
  register(descriptor: McpServerDescriptor): Promise<void>;
}

export interface InstructionsService {
  append(content: string, options?: { providers?: string[] }): Promise<void>;
}

export interface TemplatesService {
  render(templatePath: string, destination: string, data?: Record<string, string>): Promise<void>;
}

/**
 * Provider-native implementations of the context services a provider can
 * host. The engine routes capability service calls to every active provider
 * that declares the matching hosting implementation.
 */
export interface ProviderHosting {
  mcp?: {
    register(ctx: SetupContext, descriptor: McpServerDescriptor): Promise<void>;
    unregister(ctx: SetupContext, name: string): Promise<void>;
  };
  instructions?: {
    /** Absolute path of the provider's instruction surface for this companion. */
    getFilePath(ctx: SetupContext): string;
  };
}

export interface ProviderPlugin extends Plugin {
  kind: "provider";
  hosting?: ProviderHosting;
}

/**
 * A CLI subcommand contributed by a plugin. `createMate` mounts each entry on
 * the distribution binary as `<distribution> cap <namespace> <name>` (the
 * namespace defaults to the plugin id, overridable via `cliNamespace`),
 * independent of plugin selection — commands guard their own preconditions
 * (see `ensureCapabilityEnabled`). Framework `cap` subcommands always win
 * over plugin namespaces.
 */
export interface PluginCliCommand {
  name: string;
  description: string;
  run(argv: string[]): Promise<void>;
}

export interface Plugin {
  id: string;
  kind: "provider" | "capability" | "packageManager" | "integration" | "root";
  label: string;
  description: string;
  defaultSelected: boolean;
  isEnabled(config: FrameworkConfig): boolean;
  apply(ctx: SetupContext): Promise<void>;
  teardown(ctx: SetupContext): Promise<void>;
  gitignoreEntries?(ctx: SetupContext): string[];
  persistGitignoreEntries?: boolean;
  getInstallRequirements?(ctx: InstallRequirementContext): InstallRequirement[];
  cliCommands?: PluginCliCommand[];
  /** CLI namespace for `cliCommands` under `<distribution> cap`; defaults to `id`. */
  cliNamespace?: string;
}

/**
 * Governs how a distribution treats a registered plugin:
 * - "required": always enabled, locked in selection surfaces, never torn down by deselection
 * - "default": pre-selected but deselectable
 * - "optional": opt-in
 */
export type PluginPolicy = "required" | "default" | "optional";

/**
 * A plugin registration entry. Bare plugins derive their policy from
 * `defaultSelected` (`true` → "default", `false` → "optional").
 */
export type PluginRegistration = Plugin | { plugin: Plugin; policy: PluginPolicy };

/**
 * A hook group a Capability contributes to a runtime's settings. `marker` is
 * the command substring that identifies the group as Mate-managed (D4 marker
 * scheme): reconciliation strips every group whose command contains any
 * declared marker before re-adding the groups of enabled Capabilities.
 */
export interface HookGroupContribution {
  event: string;
  marker: string;
  group: ClaudeHookGroup;
}

/** A skill directory copied into `<runtime dir>/skills/<name>`. */
export interface SkillTreeContribution {
  name: string;
  sourceDir: string;
}

/**
 * A managed guidance section in the runtime's agent instruction file
 * (CLAUDE.md / AGENTS.md). Reconciled as a framework-managed block; on
 * teardown a section in a file shared with another active runtime is only
 * stripped together with the last runtime using that file.
 */
export interface GuidanceSectionContribution {
  content: string;
}

/**
 * A plugin reference entry in the runtime's config (OpenCode `plugin` array).
 * `isManagedReference` identifies entries this contribution owns so stale
 * variants (e.g. older pins) are replaced and teardown removes only them.
 */
export interface PluginReferenceContribution {
  reference: string;
  isManagedReference(entry: unknown): boolean;
  /** Config files to reconcile, relative to the runtime dir. Defaults to both OpenCode configs. */
  configFiles?: string[];
}

/**
 * Declarative Agent Runtime contributions of one Capability for one runtime.
 * The runtime's Runtime Surface reconciles these symmetrically: applied while
 * the Capability is enabled, removed when it is not, idempotent across runs.
 */
export interface RuntimeContributions {
  mcpServers?: McpServerDescriptor[];
  hookGroups?: HookGroupContribution[];
  permissionEntries?: string[];
  guidanceSections?: GuidanceSectionContribution[];
  skillTrees?: SkillTreeContribution[];
  pluginReferences?: PluginReferenceContribution[];
}

/**
 * Contributions keyed by runtime id ("claude", "opencode"). Keyed-by-runtime
 * because the payload shapes are runtime-specific (hook groups are
 * Claude-shaped, plugin references OpenCode-shaped); a runtime-agnostic
 * declaration would only push translation into every capability.
 */
export type RuntimeContributionsByRuntime = Partial<Record<string, RuntimeContributions>>;

/**
 * One Capability's contributions for one runtime, as handed to that runtime's
 * Runtime Surface reconciliation. Disabled Capabilities participate too: their
 * declarations define the managed entries to strip.
 */
export interface CapabilityContributionInput {
  pluginId: string;
  enabled: boolean;
  contributions: RuntimeContributions;
}

export interface CapabilityPlugin extends Plugin {
  kind: "capability";
  requires?: { packageManagers: string[] };
  /**
   * Declare Agent Runtime contributions as data. Called on every setup/sync
   * pass for all registered Capabilities — enabled ones contribute their
   * entries, disabled ones only widen the managed strip set so their previous
   * entries are removed.
   */
  getRuntimeContributions?(ctx: SetupContext): RuntimeContributionsByRuntime;
  forProvider?: Record<
    string,
    {
      apply(ctx: SetupContext): Promise<void>;
      teardown(ctx: SetupContext): Promise<void>;
      preflight?(ctx: LaunchPreflightContext): Promise<string[]>;
    }
  >;
}
