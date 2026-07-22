import type { FrameworkConfig } from "../../lib/orchestrator/types";

export type InstallRequirementGroup = "core" | "companion";

export interface InstallRequirementContext {
  companionPath?: string;
  config: FrameworkConfig;
}

export interface InstallRequirement {
  id: string;
  label: string;
  group: InstallRequirementGroup;
  source: string;
  command: string;
  fingerprint?: string;
  detect(): boolean | Promise<boolean>;
  install(): Promise<void>;
  verify?(): boolean | Promise<boolean>;
}
