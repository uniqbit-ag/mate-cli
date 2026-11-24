import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";

/**
 * A plugin workspace (package.json, lockfile, node_modules): the shared one
 * for base plugins, or `audiences/<name>/` below it for one audience's.
 */
export function dynamicPluginsWorkspaceRoot(
  companionPath: string,
  audience: string | null = null,
): string {
  const shared = path.join(companionPath, `.${FRAMEWORK_NAME}`, "plugins");
  return audience === null ? shared : path.join(shared, "audiences", audience);
}

/** Parent of every audience workspace. */
export function audienceWorkspacesRoot(companionPath: string): string {
  return path.join(dynamicPluginsWorkspaceRoot(companionPath), "audiences");
}

/** Root of one installed package inside a workspace's node_modules. */
export function workspacePackageRoot(workspaceRoot: string, packageName: string): string {
  return path.join(workspaceRoot, "node_modules", ...packageName.split("/"));
}

/** Root of one installed plugin package in the workspace of its origin. */
export function pluginPackageRoot(
  companionPath: string,
  packageName: string,
  audience: string | null = null,
): string {
  return workspacePackageRoot(dynamicPluginsWorkspaceRoot(companionPath, audience), packageName);
}

/** Gitignored per-machine override file deep-merged over committed plugin config. */
export function pluginLocalOverridesPath(companionPath: string): string {
  return path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "plugins.local.yaml");
}

/** Companion-relative gitignore entry for the local override file. */
export const PLUGIN_LOCAL_OVERRIDES_GITIGNORE_ENTRY = `.${FRAMEWORK_NAME}/config/plugins.local.yaml`;

/** Companion-relative gitignore entry for the shared workspace's local, never-committed registry credentials. */
export const PLUGIN_WORKSPACE_NPMRC_GITIGNORE_ENTRY = `.${FRAMEWORK_NAME}/plugins/.npmrc`;

/** Companion-relative gitignore entry for the registry file linked into every audience workspace. */
export const PLUGIN_AUDIENCE_NPMRC_GITIGNORE_ENTRY = `.${FRAMEWORK_NAME}/plugins/audiences/*/.npmrc`;
