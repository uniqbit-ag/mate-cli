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
  /**
   * Capabilities that recommend this requirement instead of mandating it: the
   * companion selects them for the team, each member decides whether the tool
   * is installed for them. Active once the member accepts any of them (or the
   * tool is already there); never installed by `--yes` alone. Absent means
   * the requirement is mandatory.
   */
  recommendedBy?: string[];
  detect(): boolean | Promise<boolean>;
  install(): Promise<void>;
  verify?(): boolean | Promise<boolean>;
  /** Best-effort refresh of an already-satisfied requirement; must never throw. */
  update?(): Promise<void>;
}
