import fs from "node:fs/promises";
import path from "node:path";

import { effectivePluginEntries, readFrameworkRaw, resolveAudience } from "./audiences";
import { validateDeclaration } from "./declarations";
import { readLoadableEntries } from "./local";
import { pluginPackageRoot, type PluginOrigin } from "./paths";

/** One effective plugin that is installed in the workspace of its origin. */
export interface InstalledPluginPackage {
  /** The declared package name. */
  package: string;
  /** The installed `package.json` version; empty when it names none. */
  version: string;
  /** The package directory. */
  root: string;
  origin: PluginOrigin;
}

export interface InstalledPluginsOptions {
  /** The active audience; null or an undeclared one lists the base plugins only. */
  audience?: string | null;
  /** Also list this machine's local plugins (default true). */
  includeLocal?: boolean;
}

/**
 * The companion's effective plugins that are installed, in hydration order: base, the
 * active audience's, then local ones. Reads `framework.yaml` and each package's
 * `package.json` only, never plugin code. A declared plugin that is not installed, or whose
 * `package.json` is unreadable, is left out. An unreadable companion lists none.
 */
export async function installedPluginPackages(
  companionPath: string,
  options: InstalledPluginsOptions = {},
): Promise<InstalledPluginPackage[]> {
  let raw: unknown;
  try {
    raw = await readFrameworkRaw(companionPath);
  } catch {
    return [];
  }
  const audience = resolveAudience(raw, options.audience ?? null);
  const active = audience.ok ? audience.active : null;
  const entries =
    options.includeLocal === false
      ? effectivePluginEntries(raw, active)
      : (await readLoadableEntries(companionPath, raw, active)).entries;

  const seen = new Set<string>();
  const installed: InstalledPluginPackage[] = [];
  for (const { entry, origin } of entries) {
    const { declaration } = validateDeclaration(entry);
    if (!declaration || seen.has(declaration.package)) continue;
    seen.add(declaration.package);
    const root = pluginPackageRoot(companionPath, declaration.package, origin);
    let manifest: unknown;
    try {
      // oxlint-disable-next-line no-await-in-loop -- declared order is part of the contract
      manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const version = (manifest as { version?: unknown } | null)?.version;
    installed.push({
      package: declaration.package,
      version: typeof version === "string" ? version : "",
      root,
      origin,
    });
  }
  return installed;
}
