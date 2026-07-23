import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type { CapabilityPlugin, SetupContext } from "../plugin";
import type { InstallRequirement } from "../install-contract";
import {
  isCommandOnPath,
  pruneEmptyAncestors,
  runCommandSilently,
  runShellCommand,
} from "../utils";
import { confirm } from "../../../cli/confirm";
import { frameworkConfig } from "../../../framework";

function defaultIsInstalledViaUvTool(pkgName: string): boolean {
  try {
    const output = execFileSync("uv", ["tool", "list"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.includes(pkgName);
  } catch {
    return false;
  }
}

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
  codex: ".codex",
  opencode: ".opencode",
};

// Companion-local graphify-out path prefix using Mate-injected env vars.
// Replaces cwd-relative graphify-out/ in Graphify-managed Codex runtime instructions.
export const GRAPHIFY_COMPANION_OUT_PREFIX =
  "$MATE_ARTIFACT_PATH/.graphify/$MATE_REPO_ID/graphify-out/";

const GRAPHIFY_START = `<!-- ${frameworkConfig.name.toUpperCase()}:GRAPHIFY:START -->`;
const GRAPHIFY_END = `<!-- ${frameworkConfig.name.toUpperCase()}:GRAPHIFY:END -->`;

// Per-provider root agent instruction files used for graphify cleanup on teardown.
const GRAPHIFY_AGENT_FILES: Record<string, string> = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  opencode: "AGENTS.md",
};

export const GRAPHIFY_SUPPORTED_PROVIDERS = Object.keys(GRAPHIFY_PROVIDER_DIRS);

interface ClaudeHookCommand {
  type?: string;
  command?: string;
  args?: string[];
}

interface ClaudeHookGroup {
  matcher?: string;
  hooks?: ClaudeHookCommand[];
}

type ClaudeHookMap = Record<string, ClaudeHookGroup[]>;

const CLAUDE_MANAGED_HOOK_COMMAND_SUFFIXES = new Set([
  "/.claude/hooks/validate-artifact-path",
  "/.claude/hooks/mate-session-banner",
  "/.claude/hooks/react-doctor.sh",
  "/.claude/hooks/mate-openspec-artifact-finish.sh",
]);

export function deriveGraphifyProviders(activeProviders: string[]): string[] {
  return GRAPHIFY_SUPPORTED_PROVIDERS.filter((p) => activeProviders.includes(p));
}

function isGraphifyHeading(line: string): boolean {
  return /^#{1,6}\s+graphify\s*$/i.test(line);
}

function stripGraphifyMarkers(lines: string[]): string[] {
  return lines.filter((line) => line !== GRAPHIFY_START && line !== GRAPHIFY_END);
}

function findGraphifySectionBounds(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex(isGraphifyHeading);
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ") || lines[i].startsWith("# ")) {
      end = i;
      break;
    }
  }

  return { start, end };
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
const GRAPHIFY_SKILL_REWRITE_EXCLUDE = new Set(["github-and-merge.md"]);

async function patchGraphifySkillFile(skillPath: string): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(skillPath, "utf8");
  } catch {
    return; // file absent (graphify binary not installed) — nothing to patch
  }
  const rewritten = rewriteGraphifySkillOutputPaths(content);
  if (rewritten !== content) await fs.writeFile(skillPath, rewritten, "utf8");
}

// Rewrite output paths across the installed skill: SKILL.md plus every
// references/*.md (excluding GRAPHIFY_SKILL_REWRITE_EXCLUDE). Directory-driven
// so reference files graphifyy adds in future releases are covered automatically.
async function patchGraphifySkillTree(skillDir: string): Promise<void> {
  await patchGraphifySkillFile(path.join(skillDir, "SKILL.md"));

  const refsDir = path.join(skillDir, "references");
  let entries: string[];
  try {
    entries = await fs.readdir(refsDir);
  } catch {
    return; // no references/ dir
  }
  const targets = entries.filter(
    (name) => name.endsWith(".md") && !GRAPHIFY_SKILL_REWRITE_EXCLUDE.has(name),
  );
  await Promise.all(targets.map((name) => patchGraphifySkillFile(path.join(refsDir, name))));
}

// Removes the graphify section from content, collapsing leftover blank lines.
export function removeGraphifySection(content: string): string {
  const normalizedLines = stripGraphifyMarkers(content.split("\n"));
  const bounds = findGraphifySectionBounds(normalizedLines);
  if (!bounds) {
    const strippedMarkersOnly = normalizedLines.join("\n");
    return strippedMarkersOnly === content ? content : strippedMarkersOnly;
  }

  const remaining = [
    ...normalizedLines.slice(0, bounds.start),
    ...normalizedLines.slice(bounds.end),
  ].join("\n");
  const collapsed = remaining.replace(/\n{3,}/g, "\n\n").trim();
  return collapsed ? collapsed + "\n" : "";
}

async function stripAgentFile(filePath: string): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }
  const stripped = removeGraphifySection(content);
  if (stripped === content) return;
  if (!stripped.trim()) {
    await fs.unlink(filePath);
  } else {
    await fs.writeFile(filePath, stripped, "utf8");
  }
}

async function stripLegacyClaudeGraphifyFile(companionPath: string): Promise<void> {
  const legacyPath = path.join(companionPath, ".claude", "CLAUDE.md");
  await stripAgentFile(legacyPath);
  await pruneEmptyAncestors(path.join(companionPath, ".claude"), companionPath);
}

function hookEntryKey(entry: ClaudeHookGroup): string {
  return JSON.stringify(entry);
}

function mergeClaudeHookGroups(
  existingHooks: ClaudeHookMap,
  incomingHooks: ClaudeHookMap,
): ClaudeHookMap {
  const merged: ClaudeHookMap = { ...existingHooks };
  for (const [event, entries] of Object.entries(incomingHooks)) {
    const current = merged[event] ?? [];
    const seen = new Set(current.map(hookEntryKey));
    merged[event] = [...current];
    for (const entry of entries ?? []) {
      const key = hookEntryKey(entry);
      if (seen.has(key)) continue;
      merged[event].push(entry);
      seen.add(key);
    }
  }
  return merged;
}

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

async function removeGraphifyClaudeHooks(companionPath: string): Promise<void> {
  const settingsLocalPath = path.join(companionPath, ".claude", "settings.local.json");

  try {
    const raw = await fs.readFile(settingsLocalPath, "utf8");
    const settings = JSON.parse(raw) as { hooks?: ClaudeHookMap } & Record<string, unknown>;
    const existingHooks = settings.hooks ?? {};
    let changed = false;

    for (const [event, existingEntries] of Object.entries(existingHooks)) {
      if (!existingEntries?.length) continue;
      const nextEntries = existingEntries.filter((entry) => !isGraphifyClaudeHookGroup(entry));

      if (nextEntries.length !== existingEntries.length) {
        changed = true;
        if (nextEntries.length > 0) {
          existingHooks[event] = nextEntries;
        } else {
          delete existingHooks[event];
        }
      }
    }

    if (Object.keys(existingHooks).length === 0) {
      if (Object.prototype.hasOwnProperty.call(settings, "hooks")) changed = true;
      delete settings.hooks;
    } else {
      settings.hooks = existingHooks;
    }

    if (changed) {
      await fs.writeFile(settingsLocalPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    }
  } catch {
    /* settings absent or malformed */
  }
}

async function removeOpenCodePlugin(filePath: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(parsed.plugin)) {
      parsed.plugin = (parsed.plugin as string[]).filter((p) => !p.includes("graphify"));
      if ((parsed.plugin as string[]).length === 0) delete parsed.plugin;
    }
    if (Object.keys(parsed).length === 0) {
      await fs.unlink(filePath);
    } else {
      await fs.writeFile(filePath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
    }
  } catch {
    // JSON parse error — leave file untouched
  }
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
  const checkUvTool = deps.isInstalledViaUvTool ?? defaultIsInstalledViaUvTool;
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
      await stripAgentFile(path.join(ctx.companionPath, "AGENTS.md"));
      // Don't uninstall the global graphify binary — companion-managed files are
      // cleaned up per-provider in forProvider[].teardown. Graph data under
      // .graphify/ is retained as user data.
    },

    forProvider: Object.fromEntries(
      GRAPHIFY_SUPPORTED_PROVIDERS.map((providerId) => [
        providerId,
        {
          async apply(ctx: SetupContext) {
            const providerDir = GRAPHIFY_PROVIDER_DIRS[providerId];

            // Reconcile Graphify-managed provider assets from the companion root
            const isInstalled =
              checkPath("graphify", process.env.PATH ?? "") || checkUvTool("graphifyy");
            if (isInstalled) {
              await runProviderInstall(
                "graphify",
                ["install", "--project", "--platform", providerId],
                { cwd: ctx.companionPath },
              );

              // graphify install writes a ## graphify section to the agent file.
              // Strip it since guidance is now delivered at runtime via system prompt.
              const agentFile = GRAPHIFY_AGENT_FILES[providerId];
              if (agentFile) {
                // `graphify install` runs with cwd=companionPath, so it writes the
                // section to the companion root agent file (CLAUDE.md / AGENTS.md).
                // Strip there. Also strip the per-provider path in case a future
                // graphify release targets it instead.
                await stripAgentFile(path.join(ctx.companionPath, agentFile));
                await stripAgentFile(path.join(ctx.companionPath, providerDir, agentFile));

                // Also strip from the repo-level files when syncing from a linked repo.
                if (ctx.repoPath) {
                  await stripAgentFile(path.join(ctx.repoPath, agentFile));
                }
              }

              // graphify install also writes "plugin": [".opencode/plugins/graphify.js"]
              // to opencode.json. Because the config lives inside companionPath/.opencode/,
              // the relative path resolves to companionPath/.opencode/.opencode/plugins/
              // (double .opencode) — a broken path. Opencode auto-discovers plugins from
              // plugins/ anyway, so strip the explicit entry to avoid duplicate loading.
              if (providerId === "opencode") {
                await removeOpenCodePlugin(
                  path.join(ctx.companionPath, ".opencode", "opencode.json"),
                );
              }

              // graphify install writes .claude/settings.json with hook guards.
              // Merge its hooks into settings.local.json (where hooks are managed),
              // then remove the tracked file.
              if (providerId === "claude") {
                const settingsJsonPath = path.join(ctx.companionPath, ".claude", "settings.json");
                const settingsLocalPath = path.join(
                  ctx.companionPath,
                  ".claude",
                  "settings.local.json",
                );
                try {
                  const settingsJsonRaw = await fs.readFile(settingsJsonPath, "utf8");
                  const settingsJson = JSON.parse(settingsJsonRaw) as {
                    hooks?: ClaudeHookMap;
                  } & Record<string, unknown>;

                  const settingsLocalRaw = await fs.readFile(settingsLocalPath, "utf8");
                  const settingsLocal = JSON.parse(settingsLocalRaw) as {
                    hooks?: ClaudeHookMap;
                  } & Record<string, unknown>;

                  if (settingsJson.hooks && Object.keys(settingsJson.hooks).length > 0) {
                    settingsLocal.hooks = mergeClaudeHookGroups(
                      settingsLocal.hooks ?? {},
                      settingsJson.hooks,
                    );
                  }

                  await fs.writeFile(
                    settingsLocalPath,
                    JSON.stringify(settingsLocal, null, 2) + "\n",
                    "utf8",
                  );
                } catch {
                  /* settings files absent or malformed — just remove settings.json */
                }
                try {
                  await fs.unlink(settingsJsonPath);
                } catch {
                  /* not present */
                }
              }
            }

            // Redirect the freshly-installed skill's cwd-relative graphify-out/
            // paths (SKILL.md + references) to the companion-local store. Runs
            // every setup/sync so it survives graphifyy regenerating the skill.
            await patchGraphifySkillTree(
              path.join(ctx.companionPath, providerDir, "skills", "graphify"),
            );
          },

          async teardown(ctx: SetupContext) {
            const providerDir = GRAPHIFY_PROVIDER_DIRS[providerId];

            if (deriveGraphifyProviders(ctx.activeProviders).length === 0) {
            }

            // Remove Graphify-managed skills directory
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

            // Strip the ## graphify section from the provider's agent instruction file,
            // but only when no other active provider also uses the same file.
            const agentFile = GRAPHIFY_AGENT_FILES[providerId];
            if (agentFile) {
              const sharedWithActive = GRAPHIFY_SUPPORTED_PROVIDERS.some(
                (otherId) =>
                  otherId !== providerId &&
                  GRAPHIFY_AGENT_FILES[otherId] === agentFile &&
                  ctx.activeProviders.includes(otherId),
              );
              if (!sharedWithActive) {
                await stripAgentFile(path.join(ctx.companionPath, agentFile));
              }
            }

            // Provider-specific cleanup for files beyond skills/
            if (providerId === "opencode") {
              try {
                await fs.unlink(
                  path.join(ctx.companionPath, ".opencode", "plugins", "graphify.js"),
                );
              } catch {
                /* not present */
              }
              await removeOpenCodePlugin(
                path.join(ctx.companionPath, ".opencode", "opencode.json"),
              );
              await pruneEmptyAncestors(
                path.join(ctx.companionPath, ".opencode", "plugins"),
                ctx.companionPath,
              );
            } else if (providerId === "claude") {
              await removeGraphifyClaudeHooks(ctx.companionPath);
              await stripLegacyClaudeGraphifyFile(ctx.companionPath);
            } else if (providerId === "codex") {
              const { reconcileCompanionCodexHookGroup } = await import("../providers/codex");
              await reconcileCompanionCodexHookGroup(
                ctx.companionPath,
                "PreToolUse",
                "graphify hook-check",
              );
            }
          },
        },
      ]),
    ),
  };
}

export const graphifyPlugin: CapabilityPlugin = createGraphifyPlugin();
