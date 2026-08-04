import fs from "node:fs/promises";
import path from "node:path";

import type { CapabilityPlugin, RuntimeContributionsByRuntime, SetupContext } from "../plugin";
import type { InstallRequirement } from "../install-contract";
import {
  isCommandOnPath,
  pruneEmptyAncestors,
  runCommandSilently,
  runShellCommand,
} from "../utils";
import { confirm } from "../../../cli/confirm";
import { FRAMEWORK_NAME } from "../../../framework";
import { getWrapperBinPath } from "../../../lib/package-paths";
import { isInstalledViaUvTool } from "../package-managers/uv";
import { stripSectionFromFile } from "../providers/agent-file-sections";
import { graphifySectionOptions } from "./graphify-shared";
export { removeGraphifySection } from "./graphify-shared";
import {
  mergeClaudeSettingsJsonHooks,
  patchClaudeSkillTree,
  removeClaudeHookGroupsWhere,
  stripClaudeForeignSections,
} from "../providers/claude";
import type { ClaudeHookGroup } from "../providers/claude-format";
import {
  patchOpenCodeSkillTree,
  removeOpenCodeForeignPluginReferences,
  stripOpenCodeForeignSections,
} from "../providers/opencode";

// Storage contract: <companionPath>/.graphify/<repositoryId>/graphify-out/
export const GRAPHIFY_STORE_SEGMENT = ".graphify";
export const GRAPHIFY_OUTPUT_SUBDIR = "graphify-out";

const GRAPHIFY_INSTALL_CMD = `uv tool install graphifyy`;
const GRAPHIFY_GITIGNORE_ENTRIES = [
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

const GRAPHIFY_PROVIDER_DIRS: Record<string, string> = {
  claude: ".claude",
  opencode: ".opencode",
};

// Companion-local graphify-out path prefix using Mate-injected env vars.
// Replaces cwd-relative graphify-out/ in Graphify-managed Codex runtime instructions.
export const GRAPHIFY_COMPANION_OUT_PREFIX =
  "$MATE_ARTIFACT_PATH/.graphify/$MATE_REPO_ID/graphify-out/";

export const GRAPHIFY_SUPPORTED_PROVIDERS = Object.keys(GRAPHIFY_PROVIDER_DIRS);

const CLAUDE_MANAGED_HOOK_COMMAND_SUFFIXES = new Set([
  "/.claude/hooks/validate-artifact-path",
  "/.claude/hooks/mate-session-banner",
  "/.claude/hooks/react-doctor.sh",
  "/.claude/hooks/mate-artifact-finish.sh",
]);

export function deriveGraphifyProviders(activeProviders: string[]): string[] {
  return GRAPHIFY_SUPPORTED_PROVIDERS.filter((p) => activeProviders.includes(p));
}

// graphifyy's `graphify install` emits a skill whose pipeline writes to a
// cwd-relative graphify-out/ using literal path strings (inline Python + bash)
// that graphifyy's own GRAPHIFY_OUT/paths.py override cannot redirect. Rewrite
// those tokens to the $GRAPHIFY_OUT env var mate injects into the launch session
// (adapters/base.ts), so agent-driven skill runs land in the companion-local
// store instead of leaking graphify-out/ into the working repo. YAML frontmatter
// is preserved verbatim (its prose description mentions graphify-out/).
export function rewriteGraphifySkillOutputPaths(content: string): string {
  const lines = content.split("\n");
  let bodyStart = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end !== -1) bodyStart = end + 1;
  }

  const head = lines.slice(0, bodyStart).join("\n");
  const body = lines
    .slice(bodyStart)
    .join("\n")
    // ${PROJECT_ROOT}/graphify-out (cwd-anchored chunk path) collapses to the
    // absolute companion dir; drop the now-wrong PROJECT_ROOT prefix.
    .replace(/\$\{PROJECT_ROOT\}\/graphify-out/g, "$GRAPHIFY_OUT")
    // remaining cwd-relative graphify-out path tokens → the session env var.
    .replace(/\bgraphify-out\b/g, "$GRAPHIFY_OUT");

  return bodyStart ? `${head}\n${body}` : body;
}

// Reference files whose graphify-out/ paths are intentionally cwd-relative or
// point at external/cloned repos (e.g. multi-repo merge) and must NOT be
// rewritten to the companion store.
const GRAPHIFY_SKILL_REWRITE_EXCLUDE = ["github-and-merge.md"];

function isMateManagedClaudeHookCommand(command: string): boolean {
  for (const suffix of CLAUDE_MANAGED_HOOK_COMMAND_SUFFIXES) {
    if (
      command.endsWith(suffix) ||
      command.includes(`${suffix}"`) ||
      command.includes(`${suffix}'`)
    ) {
      return true;
    }
  }
  return false;
}

function isGraphifyClaudeHookGroup(entry: ClaudeHookGroup): boolean {
  return (entry.hooks ?? []).some((hook) => {
    const command = hook.command?.trim();
    return command
      ? command.includes("/.claude/hooks/") && !isMateManagedClaudeHookCommand(command)
      : false;
  });
}

function isGraphifyPluginReference(entry: unknown): boolean {
  return typeof entry === "string" && entry.includes("graphify");
}

type GraphifyRunCommand = typeof runShellCommand;
type GraphifyProviderInstall = typeof runCommandSilently;

export interface GraphifyPluginDeps {
  confirm?: typeof confirm;
  isCommandOnPath?: typeof isCommandOnPath;
  isInstalledViaUvTool?: (pkgName: string) => boolean;
  runCommand?: GraphifyRunCommand;
  runProviderInstall?: GraphifyProviderInstall;
}

export function createGraphifyPlugin(deps: GraphifyPluginDeps = {}): CapabilityPlugin {
  const askConfirm = deps.confirm ?? confirm;
  const checkPath = deps.isCommandOnPath ?? isCommandOnPath;
  const checkUvTool = deps.isInstalledViaUvTool ?? isInstalledViaUvTool;
  const runCommand = deps.runCommand ?? runShellCommand;
  const runProviderInstall = deps.runProviderInstall ?? runCommandSilently;

  return {
    id: "graphify",
    kind: "capability",
    label: "Graphify",
    description:
      "Enable Graphify code graph analysis with companion-managed wrappers for supported agent sessions.",
    defaultSelected: false,
    isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "graphify"),
    // Permission pre-seeds are declared and reconciled by the Claude Runtime
    // Surface. The graphify skill trees and agent-file sections are written by
    // the external `graphify install` CLI, so they are reconciled through the
    // Runtime Surface escape hatch below instead of declarations.
    getRuntimeContributions(): RuntimeContributionsByRuntime {
      return {
        claude: {
          permissionEntries: [
            "Skill(graphify)",
            "Bash(graphify:*)",
            `Bash(${FRAMEWORK_NAME} cap graphify:*)`,
            `Bash(${path.join(getWrapperBinPath(), "graphify")}:*)`,
          ],
        },
      };
    },
    gitignoreEntries: () => GRAPHIFY_GITIGNORE_ENTRIES,
    persistGitignoreEntries: true,
    getInstallRequirements: (): InstallRequirement[] => [
      {
        id: "capability:graphify",
        label: "Graphify CLI",
        group: "companion",
        source: "Graphify capability",
        command: GRAPHIFY_INSTALL_CMD,
        fingerprint: `graphify:${GRAPHIFY_INSTALL_CMD}`,
        detect: () => checkPath("graphify", process.env.PATH ?? "") || checkUvTool("graphifyy"),
        install: () => runCommand(GRAPHIFY_INSTALL_CMD),
        verify: () => checkPath("graphify", process.env.PATH ?? "") || checkUvTool("graphifyy"),
      },
    ],

    async apply(ctx: SetupContext) {
      // binary: graphify (single y); package: graphifyy (double y)
      const isInstalled = checkPath("graphify", process.env.PATH ?? "") || checkUvTool("graphifyy");

      if (!isInstalled && ctx.mode === "setup") {
        process.stdout.write(`graphify binary not found. To install:\n  ${GRAPHIFY_INSTALL_CMD}\n`);
        const ok = await askConfirm("Run this install command now?");
        if (ok) {
          try {
            await runCommand(GRAPHIFY_INSTALL_CMD);
          } catch {
            process.stderr.write(
              `graphify: install failed — install manually with \`${GRAPHIFY_INSTALL_CMD}\`\n`,
            );
          }
        }
      }
    },

    async teardown(ctx: SetupContext) {
      await stripSectionFromFile(
        path.join(ctx.companionPath, "AGENTS.md"),
        graphifySectionOptions(),
      );
      // Don't uninstall the global graphify binary — companion-managed files are
      // cleaned up per-provider in forProvider[].teardown. Graph data under
      // .graphify/ is retained as user data.
    },

    forProvider: Object.fromEntries(
      GRAPHIFY_SUPPORTED_PROVIDERS.map((providerId) => [
        providerId,
        {
          async apply(ctx: SetupContext) {
            // Reconcile Graphify-managed provider assets from the companion root
            const isInstalled =
              checkPath("graphify", process.env.PATH ?? "") || checkUvTool("graphifyy");
            if (isInstalled) {
              await runProviderInstall(
                "graphify",
                ["install", "--project", "--platform", providerId],
                { cwd: ctx.companionPath },
              );

              // graphify install writes a ## graphify section to the agent
              // files (companion root, per-provider dir, and — when syncing
              // from a linked repo — the repo file). Strip them through the
              // escape hatch since guidance is delivered via system prompt.
              if (providerId === "claude") {
                await stripClaudeForeignSections(ctx.companionPath, {
                  ...graphifySectionOptions(),
                  repoPath: ctx.repoPath,
                });

                // graphify install writes .claude/settings.json with hook
                // guards; absorb them into the Mate-owned settings document.
                await mergeClaudeSettingsJsonHooks(ctx.companionPath);
              }

              if (providerId === "opencode") {
                await stripOpenCodeForeignSections(ctx.companionPath, {
                  ...graphifySectionOptions(),
                  repoPath: ctx.repoPath,
                });

                // graphify install also writes "plugin": [".opencode/plugins/graphify.js"]
                // to opencode.json. Because the config lives inside companionPath/.opencode/,
                // the relative path resolves to companionPath/.opencode/.opencode/plugins/
                // (double .opencode) — a broken path. Opencode auto-discovers plugins from
                // plugins/ anyway, so strip the explicit entry to avoid duplicate loading.
                await removeOpenCodeForeignPluginReferences(
                  ctx.companionPath,
                  isGraphifyPluginReference,
                );
              }
            }

            // Redirect the freshly-installed skill's cwd-relative graphify-out/
            // paths (SKILL.md + references) to the companion-local store. Runs
            // every setup/sync so it survives graphifyy regenerating the skill.
            const patchSkillTree =
              providerId === "claude" ? patchClaudeSkillTree : patchOpenCodeSkillTree;
            await patchSkillTree(ctx.companionPath, "graphify", rewriteGraphifySkillOutputPaths, {
              excludeFiles: GRAPHIFY_SKILL_REWRITE_EXCLUDE,
            });
          },

          async teardown(ctx: SetupContext) {
            const providerDir = GRAPHIFY_PROVIDER_DIRS[providerId];

            // Remove the Graphify-managed skills directory (written by the
            // external CLI, so removed here rather than via a declaration).
            try {
              await fs.rm(path.join(ctx.companionPath, providerDir, "skills", "graphify"), {
                recursive: true,
                force: true,
              });
            } catch {
              /* not present */
            }
            await pruneEmptyAncestors(
              path.join(ctx.companionPath, providerDir, "skills"),
              ctx.companionPath,
            );

            // Strip the ## graphify section and provider-specific foreign
            // config through the escape hatch. The shared AGENTS.md is kept
            // while another active runtime still uses it.
            if (providerId === "claude") {
              await stripClaudeForeignSections(ctx.companionPath, graphifySectionOptions());
              await removeClaudeHookGroupsWhere(ctx.companionPath, isGraphifyClaudeHookGroup);
            } else if (providerId === "opencode") {
              await stripOpenCodeForeignSections(ctx.companionPath, {
                ...graphifySectionOptions(),
                guardSharedFile: { activeProviders: ctx.activeProviders },
              });
              try {
                await fs.unlink(
                  path.join(ctx.companionPath, ".opencode", "plugins", "graphify.js"),
                );
              } catch {
                /* not present */
              }
              await removeOpenCodeForeignPluginReferences(
                ctx.companionPath,
                isGraphifyPluginReference,
              );
              await pruneEmptyAncestors(
                path.join(ctx.companionPath, ".opencode", "plugins"),
                ctx.companionPath,
              );
            }
          },
        },
      ]),
    ),
  };
}
