import fs from "node:fs/promises";
import path from "node:path";

import { version } from "../../../package.json";
import { FRAMEWORK_NAME } from "../../framework";
import { readClaudeSettings, type ClaudeHookMap } from "./providers/claude-format";
import {
  COMPANION_MARKETPLACE_NAME,
  COMPANION_PLUGIN_NAME,
  getCompanionClaudeSettingsPath,
} from "./providers/claude";

export const CLAUDE_PLUGIN_ROOT_TOKEN = "${CLAUDE_PLUGIN_ROOT}";

/** Marketplace scaffold validation failure with repair guidance per entry. */
export class CompanionMarketplaceError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      [
        "companion plugin marketplace validation failed:",
        ...problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
    this.name = "CompanionMarketplaceError";
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function dirHasEntries(candidate: string): Promise<boolean> {
  try {
    return (await fs.readdir(candidate)).length > 0;
  } catch {
    return false;
  }
}

/** Substrings of `value` that start with the plugin-root token, up to a delimiter. */
function extractPluginRootReferences(value: string): string[] {
  const references: string[] = [];
  let index = value.indexOf(CLAUDE_PLUGIN_ROOT_TOKEN);
  while (index >= 0) {
    let end = index;
    while (end < value.length && !"\"' \t".includes(value[end]!)) end += 1;
    references.push(value.slice(index, end));
    index = value.indexOf(CLAUDE_PLUGIN_ROOT_TOKEN, end);
  }
  return references;
}

function resolvePluginRootReference(reference: string, companionPath: string): string {
  return reference.replace(CLAUDE_PLUGIN_ROOT_TOKEN, companionPath);
}

/**
 * Rewrite absolute companion-path references to `${CLAUDE_PLUGIN_ROOT}` so
 * the generated wiring stays valid when the companion moves and never leaks
 * a per-machine prefix into the scaffold.
 */
function toPluginRootRelative(value: string, companionPath: string): string {
  return value.split(companionPath).join(CLAUDE_PLUGIN_ROOT_TOKEN);
}

interface GeneratedScaffold {
  marketplace: Record<string, unknown>;
  plugin: Record<string, unknown>;
  hooks: ClaudeHookMap | null;
}

async function buildScaffold(companionPath: string): Promise<GeneratedScaffold> {
  const problems: string[] = [];

  const skillsDir = path.join(companionPath, ".claude", "skills");
  const commandsDir = path.join(companionPath, ".claude", "commands");
  const agentsDir = path.join(companionPath, ".claude", "agents");

  // Hook wiring: the companion `.claude/settings.local.json` is Mate-owned,
  // so its hook groups are the authored capability wiring; they migrate into
  // the plugin's hooks.json with plugin-root-relative paths.
  const settings = await readClaudeSettings(getCompanionClaudeSettingsPath(companionPath));
  const authoredHooks = settings.hooks ?? {};
  const hooks: ClaudeHookMap = {};
  for (const [event, groups] of Object.entries(authoredHooks)) {
    hooks[event] = groups.map((group) => ({
      ...group,
      hooks: (group.hooks ?? []).map((hook) => ({
        ...hook,
        ...(typeof hook.command === "string"
          ? { command: toPluginRootRelative(hook.command, companionPath) }
          : {}),
        ...(Array.isArray(hook.args)
          ? { args: hook.args.map((arg) => toPluginRootRelative(arg, companionPath)) }
          : {}),
      })),
    }));
  }

  for (const groups of Object.values(hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        const referenceSources = [
          ...(typeof hook.command === "string" ? [hook.command] : []),
          ...(hook.args ?? []),
        ];
        for (const reference of referenceSources.flatMap(extractPluginRootReferences)) {
          const resolved = resolvePluginRootReference(reference, companionPath);
          if (!(await pathExists(resolved))) {
            problems.push(
              `hook command references a missing file: ${reference} (expected at ${resolved}). ` +
                `Re-run \`${FRAMEWORK_NAME} companion setup\` to restore capability hooks, or remove the stale hook.`,
            );
          }
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new CompanionMarketplaceError(problems);
  }

  const hasHooks = Object.keys(hooks).length > 0;

  const plugin: Record<string, unknown> = {
    name: COMPANION_PLUGIN_NAME,
    description:
      "Mate companion plugin generated from the authored companion layout. Do not edit; regenerate with `mate sync`.",
    version,
  };
  if (await dirHasEntries(skillsDir)) plugin.skills = ["./.claude/skills/"];
  if (await dirHasEntries(commandsDir)) plugin.commands = ["./.claude/commands/"];
  if (await dirHasEntries(agentsDir)) plugin.agents = ["./.claude/agents/"];
  if (hasHooks) plugin.hooks = "./.claude-plugin/hooks.json";
  // No `mcpServers` wiring: companion MCP servers are delivered through the
  // Mate MCP gateway (`mate mcp shim` entry in the working-repo settings).

  const marketplace: Record<string, unknown> = {
    name: COMPANION_MARKETPLACE_NAME,
    owner: { name: FRAMEWORK_NAME },
    plugins: [
      {
        name: COMPANION_PLUGIN_NAME,
        source: "./",
        description: "Companion skills, commands, agents, and hooks.",
      },
    ],
  };

  return { marketplace, plugin, hooks: hasHooks ? hooks : null };
}

async function writeJsonIfChanged(filePath: string, value: unknown): Promise<void> {
  const next = JSON.stringify(value, null, 2) + "\n";
  try {
    if ((await fs.readFile(filePath, "utf8")) === next) return;
  } catch {
    /* absent — write below */
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, next, "utf8");
}

export function getCompanionMarketplaceManifestPath(companionPath: string): string {
  return path.join(companionPath, ".claude-plugin", "marketplace.json");
}

export function getCompanionPluginManifestPath(companionPath: string): string {
  return path.join(companionPath, ".claude-plugin", "plugin.json");
}

export function getCompanionPluginHooksPath(companionPath: string): string {
  return path.join(companionPath, ".claude-plugin", "hooks.json");
}

/**
 * Generate the companion-as-marketplace scaffold from the authored layout.
 * The authored layout stays the source of truth: component fields reference
 * the authored directories in place, so regeneration reflects additions and
 * removals without copying content. Throws {@link CompanionMarketplaceError}
 * (with per-entry repair guidance) instead of writing a scaffold Claude
 * discovery would silently skip.
 */
export async function generateCompanionMarketplace(companionPath: string): Promise<void> {
  const resolvedCompanionPath = path.resolve(companionPath);
  const { marketplace, plugin, hooks } = await buildScaffold(resolvedCompanionPath);

  await writeJsonIfChanged(getCompanionMarketplaceManifestPath(resolvedCompanionPath), marketplace);
  await writeJsonIfChanged(getCompanionPluginManifestPath(resolvedCompanionPath), plugin);
  if (hooks) {
    await writeJsonIfChanged(getCompanionPluginHooksPath(resolvedCompanionPath), { hooks });
  } else {
    await fs.rm(getCompanionPluginHooksPath(resolvedCompanionPath), { force: true });
  }
}

/**
 * No-write staleness probe sharing {@link generateCompanionMarketplace}'s
 * builder: returns the scaffold files whose on-disk bytes differ from what a
 * regeneration would write (companion-relative paths). Validation problems
 * propagate as {@link CompanionMarketplaceError}.
 */
export async function collectCompanionMarketplaceStaleness(
  companionPath: string,
): Promise<string[]> {
  const resolvedCompanionPath = path.resolve(companionPath);
  const { marketplace, plugin, hooks } = await buildScaffold(resolvedCompanionPath);

  const targets: Array<[string, unknown | null]> = [
    [getCompanionMarketplaceManifestPath(resolvedCompanionPath), marketplace],
    [getCompanionPluginManifestPath(resolvedCompanionPath), plugin],
    [getCompanionPluginHooksPath(resolvedCompanionPath), hooks ? { hooks } : null],
  ];

  const stale: string[] = [];
  for (const [filePath, value] of targets) {
    const desired = value === null ? null : JSON.stringify(value, null, 2) + "\n";
    const current = await fs.readFile(filePath, "utf8").catch(() => null);
    if (current !== desired) stale.push(path.relative(resolvedCompanionPath, filePath));
  }
  return stale;
}
