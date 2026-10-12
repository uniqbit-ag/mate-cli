import os from "node:os";
import path from "node:path";

import { FRAMEWORK_NAME } from "./framework";

/**
 * Stable, install-independent paths to the installed Mate runtime assets.
 * Documents written into a Working Repository name these, never the
 * version-bound install path, so a reinstall or Node switch is repaired by the
 * next `mate` run instead of a re-wrap.
 */

/** `HOME` first, matching the companion Git state: an OpenCode service inherits the user's. */
export function mateHome(homeDir?: string): string {
  return path.join(homeDir || process.env.HOME || os.homedir(), `.${FRAMEWORK_NAME}`);
}

export function runtimeDirectoryPath(homeDir?: string): string {
  return path.join(mateHome(homeDir), "runtime");
}

export function runtimeOpenCodePluginRoot(homeDir?: string): string {
  return path.join(runtimeDirectoryPath(homeDir), "opencode-plugin");
}

export function runtimeWrapperBinPath(homeDir?: string): string {
  return path.join(runtimeDirectoryPath(homeDir), "wrappers", "bin");
}

export function runtimeMateBin(
  homeDir?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(
    runtimeDirectoryPath(homeDir),
    "bin",
    platform === "win32" ? `${FRAMEWORK_NAME}.cmd` : FRAMEWORK_NAME,
  );
}
