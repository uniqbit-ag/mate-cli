import type { FrameworkConfig } from "../../lib/orchestrator/types";
import type { InstallRequirement, InstallRequirementContext } from "./install-contract";

export interface SetupContext {
  companionPath: string;
  config: FrameworkConfig;
  mode: "setup" | "sync";
  activeProviders: string[];
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
  append(content: string): Promise<void>;
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

export interface CapabilityPlugin extends Plugin {
  kind: "capability";
  requires?: { packageManagers: string[] };
  forProvider?: Record<
    string,
    {
      apply(ctx: SetupContext): Promise<void>;
      teardown(ctx: SetupContext): Promise<void>;
    }
  >;
}
