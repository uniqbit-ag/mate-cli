import fs from "node:fs/promises";
import path from "node:path";

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

/** Strips comments and reports indentation; quoted `#` is not expected in these files. */
function lineOf(raw: string): { indent: number; text: string } {
  const text = raw.replace(/(^|\s)#.*$/, "").trimEnd();
  return { indent: text.length - text.trimStart().length, text: text.trim() };
}

/** Line of `key:` directly inside the block that starts at `from` and is deeper than `parent`. */
function findKey(lines: string[], key: string, from: number, parent: number): number {
  let child: number | undefined;
  for (let index = from; index < lines.length; index += 1) {
    const { indent, text } = lineOf(lines[index]!);
    if (!text) continue;
    if (indent <= parent) return -1;
    child ??= indent;
    if (indent === child && text.startsWith(`${key}:`)) return index;
  }
  return -1;
}

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, "$2");

/** The list under the key at `at`, flow or block; undefined when its value is null or not a list. */
function listAt(lines: string[], at: number): string[] | undefined {
  const { indent, text } = lineOf(lines[at]!);
  const value = text.slice(text.indexOf(":") + 1).trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).split(",").map(unquote).filter(Boolean);
  }
  if (value && value !== "~" && value !== "null") return undefined;
  const items: string[] = [];
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lineOf(lines[index]!);
    if (!line.text) continue;
    // A block sequence may sit at its key's indentation.
    if (line.indent < indent || !line.text.startsWith("- ")) break;
    items.push(unquote(line.text.slice(2)));
  }
  return items.length > 0 ? items : undefined;
}

/**
 * `allowedAgents` of a companion's `framework.yaml`, else legacy
 * `profiles.default.allowedAgents`, as Mate's policy reader resolves it.
 * Reads plain flow and block lists only.
 */
export function parseAllowedAgents(yaml: string): string[] | undefined {
  const lines = yaml.split(/\r?\n/);
  const top = findKey(lines, "allowedAgents", 0, -1);
  const declared = top < 0 ? undefined : listAt(lines, top);
  if (declared) return declared;
  const profiles = findKey(lines, "profiles", 0, -1);
  if (profiles < 0) return undefined;
  const parent = lineOf(lines[profiles]!).indent;
  const fallback = findKey(lines, "default", profiles + 1, parent);
  if (fallback < 0) return undefined;
  const legacy = findKey(lines, "allowedAgents", fallback + 1, lineOf(lines[fallback]!).indent);
  return legacy < 0 ? undefined : listAt(lines, legacy);
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
