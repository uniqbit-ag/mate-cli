import fs from "node:fs/promises";
import path from "node:path";

import { raiseEngineFloor } from "../../../lib/orchestrator/engine-floor";
import { audienceInstallCommand, audiencePluginPackages, pluginInstallTargets } from "./audiences";
import { installDeclaredPluginsFrozen, type FrozenInstallDeps } from "./frozen";
import {
  installDeclaredPlugins,
  readWorkspaceDependencies,
  type PluginInstallDeps,
  type PluginInstallResult,
} from "./install";
import { audienceWorkspacesRoot, dynamicPluginsWorkspaceRoot } from "./paths";

/** First Mate release with per-audience plugin workspaces; the `engines.mate` floor a migration sets. */
export const AUDIENCE_WORKSPACES_VERSION = "0.21.0";

/** One line per audience whose installed plugins a run removed. */
export function describeRemovedAudience(audience: string): string {
  return `removed the installed plugins of audience "${audience}"; run \`${audienceInstallCommand(audience)}\` to install them again`;
}

/**
 * Deletes the installed tree of every audience workspace but `active`'s.
 * Reads the directories on disk, so an audience the companion no longer
 * declares goes too; manifests and lockfiles stay. Returns the audiences
 * that had a tree.
 */
export async function removeUnselectedAudienceTrees(
  companionPath: string,
  active: string | null,
): Promise<string[]> {
  const root = audienceWorkspacesRoot(companionPath);
  const names = await fs.readdir(root).catch(() => [] as string[]);
  const removed: string[] = [];
  for (const name of names.toSorted()) {
    if (name === active) continue;
    const tree = path.join(root, name, "node_modules");
    // oxlint-disable-next-line no-await-in-loop -- a handful of directories, reported in order
    if (!(await fs.lstat(tree).catch(() => null))) continue;
    // oxlint-disable-next-line no-await-in-loop
    await fs.rm(tree, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * npm reads project configuration only from the directory it runs in, so the
 * companion's local registry file is linked into the audience workspace
 * (copied where symlinks are unavailable). A file the operator placed there
 * is kept; a link whose target is gone is dropped.
 */
export async function linkSharedNpmrc(companionPath: string, audience: string): Promise<void> {
  const shared = path.join(dynamicPluginsWorkspaceRoot(companionPath), ".npmrc");
  const workspaceRoot = dynamicPluginsWorkspaceRoot(companionPath, audience);
  const link = path.join(workspaceRoot, ".npmrc");

  const existing = await fs.lstat(link).catch(() => null);
  if (existing?.isSymbolicLink()) {
    if (await fs.stat(link).catch(() => null)) return;
    await fs.rm(link, { force: true });
  } else if (existing) {
    return;
  }
  if (!(await fs.stat(shared).catch(() => null))) return;

  await fs.mkdir(workspaceRoot, { recursive: true });
  try {
    await fs.symlink(path.relative(workspaceRoot, shared), link);
  } catch {
    await fs.copyFile(shared, link);
  }
}

export interface PluginWorkspacesOptions {
  /** Deployment restore: never rewrites a manifest, a lockfile or `framework.yaml`. */
  frozen?: boolean;
  installDeps?: PluginInstallDeps;
  frozenDeps?: FrozenInstallDeps;
}

export interface PluginWorkspacesOutcome {
  results: PluginInstallResult[];
  /** Audiences whose installed tree was removed. */
  removed: string[];
  /** Whether any installed workspace declares a plugin. */
  declared: boolean;
  /** An ordinary install moved audience packages out of the shared workspace and raised `engines.mate`. */
  migrated: boolean;
}

/**
 * The plugin step of every setup/install run: removes the installed trees of
 * unselected audiences, then installs the shared workspace from the base
 * plugins and, when `audience` selects one, that audience's own workspace.
 * No other audience's manifest or lockfile is read or written.
 *
 * A shared manifest still listing an audience package marks a companion from
 * before audience workspaces: the ordinary install rewrites it to base only
 * and raises `engines.mate`; a frozen restore refuses on the drift.
 */
export async function installPluginWorkspaces(
  companionPath: string,
  config: unknown,
  audience: string | null,
  options: PluginWorkspacesOptions = {},
): Promise<PluginWorkspacesOutcome> {
  const targets = pluginInstallTargets(config, audience);
  const active = targets.find((target) => target.audience !== null)?.audience ?? null;
  const removed = await removeUnselectedAudienceTrees(companionPath, active);

  const audiencePackages = audiencePluginPackages(config);
  const sharedRoot = dynamicPluginsWorkspaceRoot(companionPath);
  const unmigrated =
    !options.frozen &&
    Object.keys(await readWorkspaceDependencies(sharedRoot)).some((name) =>
      audiencePackages.has(name),
    );

  const results: PluginInstallResult[] = [];
  let sharedFailed = false;
  for (const target of targets) {
    const workspaceRoot = dynamicPluginsWorkspaceRoot(companionPath, target.audience);
    if (target.audience !== null && target.declarations.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- workspaces install in order, shared first
      await linkSharedNpmrc(companionPath, target.audience);
    }
    // oxlint-disable-next-line no-await-in-loop
    const installed = options.frozen
      ? await installDeclaredPluginsFrozen(workspaceRoot, target.declarations, {
          ...options.frozenDeps,
          relockCommand: audienceInstallCommand(target.audience),
          audiencePackages: target.audience === null ? audiencePackages : undefined,
        })
      : await installDeclaredPlugins(workspaceRoot, target.declarations, options.installDeps);
    if (target.audience === null) {
      sharedFailed = installed.some((result) => result.status === "failed");
    }
    results.push(...installed);
  }

  const migrated =
    unmigrated &&
    !sharedFailed &&
    (await raiseEngineFloor(companionPath, AUDIENCE_WORKSPACES_VERSION));
  return {
    results,
    removed,
    declared: targets.some((target) => target.declarations.length > 0),
    migrated,
  };
}
