import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";

/** Shared workspace root: one package.json + node_modules for every declared plugin. */
export function dynamicPluginsWorkspaceRoot(companionPath: string): string {
  return path.join(companionPath, `.${FRAMEWORK_NAME}`, "plugins");
}

/** Root of one installed plugin package inside the shared workspace's node_modules. */
export function pluginPackageRoot(companionPath: string, packageName: string): string {
  return path.join(
    dynamicPluginsWorkspaceRoot(companionPath),
    "node_modules",
    ...packageName.split("/"),
  );
}

/** Gitignored per-machine override file deep-merged over committed plugin config. */
export function pluginLocalOverridesPath(companionPath: string): string {
  return path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "plugins.local.yaml");
}

/** Companion-relative gitignore entry for the local override file. */
export const PLUGIN_LOCAL_OVERRIDES_GITIGNORE_ENTRY = `.${FRAMEWORK_NAME}/config/plugins.local.yaml`;

/** Companion-relative gitignore entry for the shared workspace's local, never-committed registry credentials. */
export const PLUGIN_WORKSPACE_NPMRC_GITIGNORE_ENTRY = `.${FRAMEWORK_NAME}/plugins/.npmrc`;
