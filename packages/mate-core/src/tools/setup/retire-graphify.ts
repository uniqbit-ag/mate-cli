import fs from "node:fs/promises";
import path from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { FRAMEWORK_NAME } from "../../framework";
import { emitWarning } from "../../lib/live-progress";
import { getWrapperBinPath } from "../../lib/package-paths";
import { writeAtomicThroughLink } from "../../runtime/write-atomic";
import type { CapabilityPlugin, SetupContext } from "./plugin";
import { stripSectionFromFile } from "./providers/agent-file-sections";
import { removeClaudeHookGroupsWhere, stripClaudeForeignSections } from "./providers/claude";
import type { ClaudeHookGroup } from "./providers/claude-format";
import {
  removeOpenCodeForeignPluginReferences,
  stripOpenCodeForeignSections,
} from "./providers/opencode";
import { pruneEmptyAncestors } from "./utils";
import { editExcludeFile } from "./working-repo-local-state";

/**
 * Temporary cleanup of what the retired graphify Capability left behind.
 * Registered as a never-enabled Capability, so the engine runs its teardown on
 * every setup and sync. Delete this module, its registration and its tests in
 * the second minor release after the one that removed graphify.
 */

const RETIRED_ID = "graphify";

export const GRAPHIFY_RETIREMENT_NOTICE =
  "The graphify capability was removed from Mate. Mate removed its local files from this companion.";

const SKILL_ROOTS = [".claude", ".opencode", ".agents"];

const IGNORE_FILE = ".graphifyignore";
const REGION_BEGIN = "# mate:secrets begin";
const REGION_END = "# mate:secrets end";

// Kept: they still keep caches of a Published Graph Store out of the companion's history.
const GITIGNORE_ENTRIES = [
  "# graphify cache (contains absolute local paths)",
  ".graphify/*/graphify-out/cache/",
  ".graphify/*/graphify-out/graph.html",
  ".graphify/*/graphify-out/.graphify_root",
  ".graphify/*/graphify-out/.graphify_python",
  "# graphify regeneratable output",
  ".graphify/*/graphify-out/obsidian/",
  ".graphify/*/graphify-out/cost.json",
  ".graphify/*/graphify-out/.graphify_labels.json",
  ".graphify/*/graphify-out/manifest.json",
  "# obsidian vault config",
  ".obsidian/",
];

function sectionOptions() {
  const marker = FRAMEWORK_NAME.toUpperCase();
  const markers: [string, string] = [
    `<!-- ${marker}:GRAPHIFY:START -->`,
    `<!-- ${marker}:GRAPHIFY:END -->`,
  ];
  return {
    isHeading: (line: string) => /^#{1,6}\s+graphify\s*$/i.test(line),
    blockMarkers: markers,
    markerLines: markers,
  };
}

// `graphify hook-guard read`, `"/abs/bin/graphify" hook-check`: by bare name or absolute path.
const CLI_HOOK_COMMAND = /(?:^|[\s/\\"'])graphify(?:\.exe)?["']?\s+hook-/;

function isGraphifyCliHookGroup(group: ClaudeHookGroup): boolean {
  return (group.hooks ?? []).some((hook) => CLI_HOOK_COMMAND.test(hook.command?.trim() ?? ""));
}

function isGraphifyPluginReference(entry: unknown): boolean {
  return typeof entry === "string" && entry.includes("graphify");
}

function isRetiredEntry(item: unknown): boolean {
  if (isScalar(item)) return item.value === RETIRED_ID;
  return isMap(item) && item.get("name") === RETIRED_ID;
}

/** Drops the `graphify` entry from the saved capabilities, keeping the rest of the file as written. */
async function dropRetiredCapability(ctx: SetupContext): Promise<boolean> {
  const file = path.join(ctx.companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
  const raw = await fs.readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return false;
  const document = parseDocument(raw);
  const capabilities = document.get("capabilities");
  if (!isSeq(capabilities)) return false;
  const kept = capabilities.items.filter((item) => !isRetiredEntry(item));
  if (kept.length === capabilities.items.length) return false;
  capabilities.items = kept;
  await writeAtomicThroughLink(file, document.toString());
  if (ctx.config.capabilities) {
    ctx.config.capabilities = ctx.config.capabilities.filter((c) => c.name !== RETIRED_ID);
  }
  return true;
}

async function removeSkillTrees(companionPath: string): Promise<void> {
  await Promise.all(
    SKILL_ROOTS.map(async (root) => {
      const skills = path.join(companionPath, root, "skills");
      await fs.rm(path.join(skills, RETIRED_ID), { recursive: true, force: true });
      await pruneEmptyAncestors(skills, companionPath);
    }),
  );
}

/** Every Mate region is removed, so a hand-copied duplicate goes too. */
function withoutRegions(content: string): string[] {
  const kept: string[] = [];
  let inside = false;
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith(REGION_BEGIN)) inside = true;
    else if (inside && line === REGION_END) inside = false;
    else if (!inside) kept.push(line);
  }
  while (kept.length > 0 && kept.at(-1)?.trim() === "") kept.pop();
  return kept;
}

async function removeSecretRegion(repoPath: string): Promise<void> {
  const file = path.join(repoPath, IGNORE_FILE);
  const existing = await fs.readFile(file, "utf8").catch(() => undefined);
  // Without Mate's region the file is the user's, and so is any exclude line for it.
  if (!existing?.includes(REGION_BEGIN)) return;
  const kept = withoutRegions(existing);
  if (kept.every((line) => line.trim() === "")) await fs.rm(file, { force: true });
  else await fs.writeFile(file, `${kept.join("\n")}\n`, "utf8");
  await editExcludeFile(repoPath, (lines) =>
    lines.filter((line) => line.trim() !== `/${IGNORE_FILE}`),
  );
}

export function createGraphifyRetirementPlugin(): CapabilityPlugin {
  return {
    id: "graphify-retirement",
    kind: "capability",
    label: "Graphify retirement",
    description: "Removes what the retired graphify capability left in a companion.",
    defaultSelected: false,
    selectable: false,
    isEnabled: () => false,
    // Declared so permission reconciliation strips them; nothing enables this Capability.
    getRuntimeContributions: () => ({
      claude: {
        permissionEntries: [
          "Skill(graphify)",
          "Bash(graphify:*)",
          `Bash(${FRAMEWORK_NAME} cap graphify:*)`,
          `Bash(${path.join(getWrapperBinPath(), "graphify")}:*)`,
          "Bash($MATE_COMPANION_BIN_PATH/graphify:*)",
        ],
      },
    }),
    gitignoreEntries: () => GITIGNORE_ENTRIES,
    persistGitignoreEntries: true,
    async apply() {},
    async teardown(ctx) {
      if (await dropRetiredCapability(ctx)) emitWarning(GRAPHIFY_RETIREMENT_NOTICE);
      await removeSkillTrees(ctx.companionPath);
      await stripSectionFromFile(path.join(ctx.companionPath, "AGENTS.md"), sectionOptions());
      if (ctx.repoPath) {
        try {
          await removeSecretRegion(ctx.repoPath);
        } catch (error) {
          emitWarning(`${FRAMEWORK_NAME}: ${(error as Error).message}`);
        }
      }
    },
    forProvider: {
      claude: {
        async apply() {},
        async teardown(ctx) {
          await stripClaudeForeignSections(ctx.companionPath, sectionOptions());
          await removeClaudeHookGroupsWhere(ctx.companionPath, isGraphifyCliHookGroup);
        },
      },
      opencode: {
        async apply() {},
        async teardown(ctx) {
          await stripOpenCodeForeignSections(ctx.companionPath, sectionOptions());
          await fs.rm(path.join(ctx.companionPath, ".opencode", "plugins", "graphify.js"), {
            force: true,
          });
          await pruneEmptyAncestors(
            path.join(ctx.companionPath, ".opencode", "plugins"),
            ctx.companionPath,
          );
          await removeOpenCodeForeignPluginReferences(ctx.companionPath, isGraphifyPluginReference);
        },
      },
    },
  };
}
