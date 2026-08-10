import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FRAMEWORK_NAME } from "../../framework";
import { getClaudePluginRoot } from "../../lib/package-paths";

export const MATE_GLOBAL_MARKETPLACE_NAME = FRAMEWORK_NAME;
/** Must match the bundled plugin's `.claude-plugin/plugin.json` name. */
export const MATE_GLOBAL_PLUGIN_NAME = FRAMEWORK_NAME;

export function mateGlobalPluginKey(): string {
  return `${MATE_GLOBAL_PLUGIN_NAME}@${MATE_GLOBAL_MARKETPLACE_NAME}`;
}

export interface GlobalClaudeRegistrationDeps {
  /** Mate home; defaults to `~/.mate`. */
  mateHomeDir?: string;
  /** User-scope Claude settings; defaults to `~/.claude/settings.json`. */
  claudeSettingsPath?: string;
  /** Bundled plugin directory inside the installed package. */
  pluginRoot?: string;
}

function defaultMateHomeDir(): string {
  return path.join(os.homedir(), `.${FRAMEWORK_NAME}`);
}

function defaultClaudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function mateGlobalMarketplaceDir(mateHomeDir = defaultMateHomeDir()): string {
  return path.join(mateHomeDir, "claude", "marketplace");
}

async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    if ((await fs.readFile(filePath, "utf8")) === content) return;
  } catch {
    /* absent */
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

/**
 * Keep the marketplace's plugin entry a symlink into the installed package
 * rather than a copy: hook shims resolve their TS sources relative to their
 * real location, so a copy would break imports, while the symlink survives
 * package updates because link/sync re-point it on every run. This is the
 * "`~/.mate`-owned stable path updated by `mate sync`" resolution of the
 * design's open question.
 */
async function ensurePluginSymlink(linkPath: string, pluginRoot: string): Promise<void> {
  const target = path.resolve(pluginRoot);
  try {
    const current = await fs.readlink(linkPath);
    if (path.resolve(path.dirname(linkPath), current) === target) return;
    await fs.rm(linkPath, { recursive: true, force: true });
  } catch {
    await fs.rm(linkPath, { recursive: true, force: true }).catch(() => {});
  }
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(target, linkPath, "dir");
}

/**
 * Register the bundled Claude plugin for global loading: maintain the
 * `~/.mate`-owned marketplace scaffold pointing at the installed package and
 * reconcile the user-scope Claude settings (`extraKnownMarketplaces` +
 * `enabledPlugins`), preserving unmanaged entries. Runs from
 * `mate companion link` and `mate sync`, so every session — CLI, IDE
 * extension, desktop — loads the plugin without a `--plugin-dir` flag.
 */
export async function registerMateClaudePluginGlobally(
  deps: GlobalClaudeRegistrationDeps = {},
): Promise<void> {
  const marketplaceDir = mateGlobalMarketplaceDir(deps.mateHomeDir);
  const pluginRoot = deps.pluginRoot ?? getClaudePluginRoot();

  await ensurePluginSymlink(
    path.join(marketplaceDir, "plugins", MATE_GLOBAL_PLUGIN_NAME),
    pluginRoot,
  );

  const marketplace = {
    name: MATE_GLOBAL_MARKETPLACE_NAME,
    owner: { name: FRAMEWORK_NAME },
    plugins: [
      {
        name: MATE_GLOBAL_PLUGIN_NAME,
        source: `./plugins/${MATE_GLOBAL_PLUGIN_NAME}`,
        description:
          "Mate session activation and guardrail hooks (bundled with @uniqbit/mate-core).",
      },
    ],
  };
  await writeFileIfChanged(
    path.join(marketplaceDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify(marketplace, null, 2) + "\n",
  );

  const settingsPath = deps.claudeSettingsPath ?? defaultClaudeSettingsPath();
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object") settings = parsed as Record<string, unknown>;
  } catch {
    /* absent or unparseable — start fresh */
  }

  const extraKnownMarketplaces = {
    ...(settings.extraKnownMarketplaces as Record<string, unknown> | undefined),
  };
  delete extraKnownMarketplaces[MATE_GLOBAL_MARKETPLACE_NAME];
  extraKnownMarketplaces[MATE_GLOBAL_MARKETPLACE_NAME] = {
    source: { source: "directory", path: marketplaceDir },
  };

  const enabledPlugins = {
    ...(settings.enabledPlugins as Record<string, boolean> | undefined),
  };
  delete enabledPlugins[mateGlobalPluginKey()];
  enabledPlugins[mateGlobalPluginKey()] = true;

  await writeFileIfChanged(
    settingsPath,
    JSON.stringify({ ...settings, extraKnownMarketplaces, enabledPlugins }, null, 2) + "\n",
  );
}
