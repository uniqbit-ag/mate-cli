import type { FrameworkConfig } from "../../lib/orchestrator/types";
import type { InstallRequirement, InstallRequirementContext } from "./install-contract";

export interface SetupContext {
  companionPath: string;
  config: FrameworkConfig;
  mode: "setup" | "sync";
  activeProviders: string[];
  /** Working repository path when syncing from a linked repo (e.g. during launch). */
  repoPath?: string;
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
