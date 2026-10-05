import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { ConfigStore, mergeWithDefaults } from "../../../lib/orchestrator/config-store";
import type { StudioInventory, StudioInventoryCompanion } from "./inventory";
import { resolveCompanion } from "./selection";
import {
  agentInstalled,
  TERMINAL_AGENTS,
  type TerminalAgent,
  type TerminalLaunchResolution,
} from "./terminal";

/** Agents the companion allows and this installation can start. */
export async function launchableAgents(
  companionPath: string,
  installed: (agent: TerminalAgent) => boolean = agentInstalled,
): Promise<TerminalAgent[]> {
  const configPath = path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
  let allowed: string[];
  try {
    allowed = mergeWithDefaults(await new ConfigStore(configPath).load()).allowedAgents;
  } catch {
    return [];
  }
  return TERMINAL_AGENTS.filter((agent) => allowed.includes(agent) && installed(agent));
}

export interface LaunchResolverOptions {
  collectInventory: () => Promise<StudioInventory>;
  /** Pinned by `serve --companion`; overrides the page selection. */
  launchCompanion?: string | null;
  launchableAgents?: (companionPath: string) => Promise<TerminalAgent[]>;
}

/** The companion a launch targets: the pinned one, else the page's, both read from the current inventory. */
export async function effectiveLaunchCompanion(
  inventory: StudioInventory,
  launchCompanion: string | null | undefined,
  digest: string | null,
): Promise<StudioInventoryCompanion | null> {
  if (launchCompanion) {
    return inventory.companions.find((companion) => companion.path === launchCompanion) ?? null;
  }
  return resolveCompanion(inventory, digest);
}

/** Revalidates at launch time; the rendered page and its digest are never trusted. */
export function createLaunchResolver(
  options: LaunchResolverOptions,
): (agent: string, digest: string | null) => Promise<TerminalLaunchResolution> {
  const agents = options.launchableAgents ?? launchableAgents;
  return async (agent, digest) => {
    const companion = await effectiveLaunchCompanion(
      await options.collectInventory(),
      options.launchCompanion,
      digest,
    );
    if (!companion) {
      return {
        reason: options.launchCompanion
          ? "the launch companion is no longer registered"
          : "no registered companion is selected",
      };
    }
    if (!(await agents(companion.path)).includes(agent as TerminalAgent)) {
      return { reason: `${agent} is not allowed by this companion or is not installed` };
    }
    return { companionPath: companion.path };
  };
}
