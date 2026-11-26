import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import type { Runtime } from "./sessions";

/** Sidebar change actions: a skill started with a first-turn prompt. Mirrors Studio's actions. */

/**
 * A change name or its dated archive anchor: lowercase letters, digits and hyphens, so it
 * can never carry shell syntax or a flag.
 */
export const SUBJECT_PATTERN = /^(?:\d{4}-\d{2}-\d{2}-)?[a-z0-9][a-z0-9-]{0,63}$/;

export type ChangeAction = "archive" | "publish";

export const CHANGE_ACTIONS: Record<
  ChangeAction,
  { skill: string; opencode: (name: string) => string }
> = {
  archive: {
    skill: "mate-archive-change",
    opencode: (name) => `Use the mate-archive-change skill on change ${name}.`,
  },
  publish: {
    skill: "mate-publish-artifact",
    opencode: (name) => `Use the mate-publish-artifact skill to publish ${name}.`,
  },
};

/** The action's first-turn prompt, or null when `name` fails {@link SUBJECT_PATTERN}. */
export function actionPrompt(action: ChangeAction, runtime: Runtime, name: string): string | null {
  if (!SUBJECT_PATTERN.test(name)) return null;
  const { skill, opencode } = CHANGE_ACTIONS[action];
  return runtime === "claude" ? `/${skill} ${name}` : opencode(name);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `allowedAgents` of a companion's `framework.yaml`, else legacy
 * `profiles.default.allowedAgents`, as Mate's policy reader resolves it.
 * Undefined when the file is invalid YAML or the value is not a list.
 */
export function parseAllowedAgents(source: string): string[] | undefined {
  let config: unknown;
  try {
    config = parse(source);
  } catch {
    return undefined;
  }
  if (!isRecord(config)) return undefined;
  const { profiles } = config;
  const agents =
    config.allowedAgents ??
    (isRecord(profiles) && isRecord(profiles.default) ? profiles.default.allowedAgents : undefined);
  return Array.isArray(agents) ? agents.filter((agent) => typeof agent === "string") : undefined;
}

/** Submenu entry order; menus are static, so `allowedAgents` order cannot apply. */
export const CHANGE_ACTION_AGENTS: readonly Runtime[] = ["claude", "opencode"];

/** The allowed agents the sidebar can start, Claude first; codex and pi are skipped. */
export function changeActionAgents(agents: readonly string[] | undefined): Runtime[] {
  return CHANGE_ACTION_AGENTS.filter((agent) => agents?.includes(agent));
}

/** The change action agents of the companion linked at `<repo>/.mate/companion`; empty when none. */
export async function readChangeActionAgents(repoRoot: string): Promise<Runtime[]> {
  const file = path.join(repoRoot, ".mate", "companion", ".mate", "config", "framework.yaml");
  const yaml = await fs.readFile(file, "utf8").catch(() => undefined);
  return yaml === undefined ? [] : changeActionAgents(parseAllowedAgents(yaml));
}
