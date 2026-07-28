import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";

/** Flattens an npm package name into a single directory segment. */
export function sanitizePluginDirName(packageName: string): string {
  return packageName.replace(/^@/, "").replace(/\//g, "-");
}

export function dynamicPluginsRoot(companionPath: string): string {
  return path.join(companionPath, `.${FRAMEWORK_NAME}`, "dependencies", "plugins");
}

/** Per-plugin install workspace holding a private package.json and node_modules. */
export function pluginInstallDir(companionPath: string, packageName: string): string {
  return path.join(dynamicPluginsRoot(companionPath), sanitizePluginDirName(packageName));
}

/** Root of the installed plugin package itself. */
export function pluginPackageRoot(companionPath: string, packageName: string): string {
  return path.join(
    pluginInstallDir(companionPath, packageName),
    "node_modules",
    ...packageName.split("/"),
  );
}

/** Committed pin file recording resolved plugin versions. */
export function pluginPinFilePath(companionPath: string): string {
  return path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "plugins.lock.yaml");
}

/** Gitignored per-machine override file deep-merged over committed plugin config. */
export function pluginLocalOverridesPath(companionPath: string): string {
  return path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "plugins.local.yaml");
}

/** Companion-relative gitignore entry for the local override file. */
export const PLUGIN_LOCAL_OVERRIDES_GITIGNORE_ENTRY = `.${FRAMEWORK_NAME}/config/plugins.local.yaml`;
