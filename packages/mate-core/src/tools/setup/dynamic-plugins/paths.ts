import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";

/** Where a plugin is declared, which decides the workspace it installs into and loads from. */
export type PluginOrigin =
  | { kind: "base" }
  | { kind: "audience"; name: string }
  | { kind: "local" };

export const BASE_PLUGIN_ORIGIN: PluginOrigin = { kind: "base" };
export const LOCAL_PLUGIN_ORIGIN: PluginOrigin = { kind: "local" };

/** The origin of an audience selection; `null` selects the base plugins. */
export function audienceOrigin(audience: string | null): PluginOrigin {
  return audience === null ? BASE_PLUGIN_ORIGIN : { kind: "audience", name: audience };
}

/**
 * A plugin workspace (package.json, lockfile, node_modules): the shared one
 * for base plugins, `audiences/<name>/` below it for one audience's, or the
 * ignored `.mate/local-plugins/` for this machine's.
 */
export function dynamicPluginsWorkspaceRoot(
  companionPath: string,
  origin: PluginOrigin = BASE_PLUGIN_ORIGIN,
): string {
  const frameworkRoot = path.join(companionPath, `.${FRAMEWORK_NAME}`);
  if (origin.kind === "local") return path.join(frameworkRoot, "local-plugins");
  const shared = path.join(frameworkRoot, "plugins");
  return origin.kind === "base" ? shared : path.join(shared, "audiences", origin.name);
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
  origin: PluginOrigin = BASE_PLUGIN_ORIGIN,
): string {
  return workspacePackageRoot(dynamicPluginsWorkspaceRoot(companionPath, origin), packageName);
}

/** Gitignored per-machine override file deep-merged over committed plugin config. */
export function pluginLocalOverridesPath(companionPath: string): string {
  return path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "plugins.local.yaml");
}

/** Gitignored file declaring the plugins of this machine only. */
export function localPluginsFilePath(companionPath: string): string {
  return path.join(companionPath, LOCAL_PLUGINS_FILE_GITIGNORE_ENTRY);
}

/** Companion-relative gitignore entry for the local override file. */
export const PLUGIN_LOCAL_OVERRIDES_GITIGNORE_ENTRY = `.${FRAMEWORK_NAME}/config/plugins.local.yaml`;

/** Companion-relative gitignore entry for the shared workspace's local, never-committed registry credentials. */
export const PLUGIN_WORKSPACE_NPMRC_GITIGNORE_ENTRY = `.${FRAMEWORK_NAME}/plugins/.npmrc`;

/** Companion-relative gitignore entry for the registry file linked into every audience workspace. */
export const PLUGIN_AUDIENCE_NPMRC_GITIGNORE_ENTRY = `.${FRAMEWORK_NAME}/plugins/audiences/*/.npmrc`;

/** Companion-relative gitignore entry for the local plugin declarations. */
export const LOCAL_PLUGINS_FILE_GITIGNORE_ENTRY = `.${FRAMEWORK_NAME}/config/framework.local.yaml`;

/** Companion-relative gitignore entry for the local plugin workspace. */
export const LOCAL_PLUGINS_WORKSPACE_GITIGNORE_ENTRY = `.${FRAMEWORK_NAME}/local-plugins/`;
