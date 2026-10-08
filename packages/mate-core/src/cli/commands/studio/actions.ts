import type { StudioSkillInventory } from "./mate-inventory";
import type { TerminalAgent } from "./terminal";

/** Lowercase letters, digits and hyphens, so a subject can never carry shell syntax or a flag. */
export const SUBJECT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A skill Studio may launch with a subject. Fixed in code: the registry, not
 * an installed skill directory, authorizes an action.
 */
export interface StudioAction {
  id: string;
  skill: string;
  label: string;
  subject: "spec";
  prompts: Record<TerminalAgent, (subject: string) => string>;
}

export const STUDIO_ACTIONS: readonly StudioAction[] = [
  {
    id: "show-me",
    skill: "mate-show-me",
    label: "Show me",
    subject: "spec",
    prompts: {
      claude: (subject) => `/mate-show-me ${subject}`,
      opencode: (subject) => `Use the mate-show-me skill on spec ${subject}.`,
    },
  },
];

export function findAction(id: unknown): StudioAction | null {
  return STUDIO_ACTIONS.find((action) => action.id === id) ?? null;
}

/** Skill trees each agent loads; Claude does not read the shared Agents tree. */
const SKILL_TREES: Record<TerminalAgent, (keyof StudioSkillInventory)[]> = {
  claude: ["claude"],
  opencode: ["opencode", "agents"],
};

/** Availability only: a directory shows the skill is installed, not that Mate shipped it. */
export function skillInstalledFor(
  inventory: StudioSkillInventory,
  skill: string,
  agent: TerminalAgent,
): boolean {
  return SKILL_TREES[agent].some((tree) => inventory[tree].includes(skill));
}

/** The first-turn prompt arguments for one agent: a trailing positional for Claude, `--prompt` for OpenCode. */
export function promptArgs(action: StudioAction, agent: TerminalAgent, subject: string): string[] {
  const prompt = action.prompts[agent](subject);
  return agent === "opencode" ? ["--prompt", prompt] : [prompt];
}

/** What the Specs view renders for one action on the displayed companion. */
export interface SpecActionOffer {
  action: StudioAction;
  /** Agents a run button may start; empty without a matching terminal. */
  runAgents: TerminalAgent[];
  /** Agents whose prompt Copy may offer. */
  copyAgents: TerminalAgent[];
}

const AGENTS: readonly TerminalAgent[] = ["claude", "opencode"];

/**
 * Run needs a terminal targeting the displayed companion and a launchable
 * agent with the skill; Copy needs only the installed skill.
 */
export function specActionOffers(
  companionPath: string,
  inventory: StudioSkillInventory | undefined,
  terminal: { target: { path: string } | null; agents: TerminalAgent[] } | null,
): SpecActionOffer[] {
  if (!inventory) return [];
  const targeted = terminal?.target?.path === companionPath;
  return STUDIO_ACTIONS.flatMap((action) => {
    const copyAgents = AGENTS.filter((agent) => skillInstalledFor(inventory, action.skill, agent));
    if (copyAgents.length === 0) return [];
    const runAgents = targeted
      ? copyAgents.filter((agent) => terminal?.agents.includes(agent))
      : [];
    return [{ action, runAgents, copyAgents }];
  });
}
