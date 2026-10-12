import fs from "node:fs";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import { ConfigStore, mergeWithDefaults } from "../../../lib/orchestrator/config-store";
import type { StudioInventory, StudioInventoryCompanion } from "./inventory";
import { findAction, promptArgs, skillInstalledFor, SUBJECT_PATTERN } from "./actions";
import { collectSkillInventory, type StudioSkillInventory } from "./mate-inventory";
import { listSpecs } from "./openspec-cli";
import { resolveCompanion } from "./selection";
import {
  agentInstalled,
  TERMINAL_AGENTS,
  type TerminalAction,
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

/** Lowercase letters, digits and hyphens, so a name can never carry shell syntax or a flag. */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const AGENT_DEFINITION_DIRS: Record<TerminalAgent, string> = {
  claude: path.join(".claude", "agents"),
  opencode: path.join(".opencode", "agents"),
};

export interface DefaultAgentOutcome {
  agentArgs?: string[];
  notice?: string;
}

/**
 * The companion's `studio.terminal.agent` for one provider. Never throws and
 * never echoes the configured value into the notice.
 */
export async function defaultAgentFor(
  companionPath: string,
  agent: TerminalAgent,
): Promise<DefaultAgentOutcome> {
  const configPath = path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
  if (!fs.existsSync(configPath)) return {};
  let name: unknown;
  try {
    name = (await new ConfigStore(configPath).load()).studio?.terminal?.agent;
  } catch {
    return {};
  }
  if (name === undefined || name === null) return {};
  if (typeof name !== "string" || !AGENT_NAME_PATTERN.test(name)) {
    return {
      notice: "Default agent not applied: studio.terminal.agent is not a valid agent name.",
    };
  }
  const definition = path.join(companionPath, AGENT_DEFINITION_DIRS[agent], `${name}.md`);
  if (!fs.existsSync(definition)) {
    return {
      notice: `Default agent "${name}" not applied: this companion has no ${agent} definition for it.`,
    };
  }
  return { agentArgs: ["--agent", name] };
}

export interface LaunchResolverOptions {
  collectInventory: () => Promise<StudioInventory>;
  /** Pinned by `serve --companion`; overrides the page selection. */
  launchCompanion?: string | null;
  launchableAgents?: (companionPath: string) => Promise<TerminalAgent[]>;
  defaultAgent?: (companionPath: string, agent: TerminalAgent) => Promise<DefaultAgentOutcome>;
  skillInventory?: (companionPath: string) => Promise<StudioSkillInventory>;
  /** Whether the companion has a canonical spec for this capability, read at launch. */
  specExists?: (companionPath: string, capability: string) => Promise<boolean>;
}

async function specInCompanion(companionPath: string, capability: string): Promise<boolean> {
  const result = await listSpecs(companionPath);
  return result.ok && (result.value.specs ?? []).some((spec) => spec.id === capability);
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
): (
  agent: string,
  digest: string | null,
  action?: TerminalAction,
) => Promise<TerminalLaunchResolution> {
  const agents = options.launchableAgents ?? launchableAgents;
  const defaultAgent = options.defaultAgent ?? defaultAgentFor;
  const skills = options.skillInventory ?? collectSkillInventory;
  const specExists = options.specExists ?? specInCompanion;
  return async (agent, digest, request) => {
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
    const launch = {
      companionPath: companion.path,
      ...(await defaultAgent(companion.path, agent as TerminalAgent)),
    };
    if (!request) return launch;

    const action = findAction(request.action);
    if (!action) return { reason: "the requested action is not registered" };
    const subject = request.subject;
    if (typeof subject !== "string" || !SUBJECT_PATTERN.test(subject)) {
      return { reason: "the action subject is not a valid spec name" };
    }
    if (!skillInstalledFor(await skills(companion.path), action.skill, agent as TerminalAgent)) {
      return {
        reason: `the ${action.skill} skill is not installed for ${agent} in this companion`,
      };
    }
    if (!(await specExists(companion.path, subject))) {
      return { reason: `this companion has no spec named ${subject}` };
    }
    return { ...launch, promptArgs: promptArgs(action, agent as TerminalAgent, subject) };
  };
}
