import fs from "node:fs/promises";
import path from "node:path";

import semver from "semver";

import { FRAMEWORK_NAME } from "../framework";

/**
 * A plugin reference bound to installed files is an absolute path to the
 * installed package root, so the Agent Runtime loads it instead of resolving,
 * fetching, or installing the published package.
 */
/** The framework-owned machine-local workspace; a leaf definition, since the
 * managed-reference predicates depend on it. */
export function getLocalWorkspaceDir(companionPath: string): string {
  return path.join(companionPath, `.${FRAMEWORK_NAME}`, "plugins", ".local");
}

/**
 * Written by prebuilt preparation, and the only mark that the distribution
 * *supplied* an installed workspace. Ordinary setup installs into the same
 * location, and that must keep writing the published reference.
 */
export const PREBUILT_BUNDLE_MARKER = ".mate-prebuilt.json";

export function getPreinstalledPluginDir(companionPath: string, packageName: string): string {
  return path.join(getLocalWorkspaceDir(companionPath), "node_modules", ...packageName.split("/"));
}

/** True for a reference that is a path whose last segment is the package itself. */
export function isPreinstalledPluginPath(entry: unknown, packageName: string): boolean {
  if (typeof entry !== "string") return false;
  if (!entry.includes("/") && !entry.includes("\\")) return false;
  const normalized = entry.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.endsWith(`/${packageName}`);
}

export class PreinstalledPluginMismatchError extends Error {}

/**
 * Resolves an installed copy of a declared plugin package from a workspace the
 * distribution supplied. Returns null where none was supplied — the ordinary
 * workstation, whose setup-installed workspace carries no bundle marker, so the
 * published reference is written exactly as before. A supplied copy that does
 * not match what the Capability declares is reported by name rather than bound,
 * and nothing is installed to repair it.
 */
export async function resolvePreinstalledPluginReference(
  companionPath: string,
  packageName: string,
  expectedVersion: string,
  nodeVersion: string = process.versions.node,
): Promise<string | null> {
  const workspace = getLocalWorkspaceDir(companionPath);
  const supplied = await fs.access(path.join(workspace, PREBUILT_BUNDLE_MARKER)).then(
    () => true,
    () => false,
  );
  if (!supplied) return null;

  const dir = getPreinstalledPluginDir(companionPath, packageName);
  let manifest: { version?: string; engines?: { node?: string } };
  try {
    manifest = JSON.parse(
      await fs.readFile(path.join(dir, "package.json"), "utf8"),
    ) as typeof manifest;
  } catch {
    return null;
  }

  if (manifest.version !== expectedVersion) {
    throw new PreinstalledPluginMismatchError(
      `${packageName}: the installed copy at ${dir} is ${manifest.version ?? "an unknown version"}; the capability declares ${expectedVersion}.`,
    );
  }
  if (manifest.engines?.node && !semver.satisfies(nodeVersion, manifest.engines.node)) {
    throw new PreinstalledPluginMismatchError(
      `${packageName}: the installed copy at ${dir} requires Node.js ${manifest.engines.node}; this runtime is ${nodeVersion}.`,
    );
  }
  return dir;
}
