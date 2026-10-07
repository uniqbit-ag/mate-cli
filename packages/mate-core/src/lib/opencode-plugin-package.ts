import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isPreinstalledPluginPath } from "./preinstalled-plugins";
import { PUBLIC_NPM_REGISTRY } from "./public-npm";

/** The retired plugin package, bundled into mate-core as `opencode-plugin/`. */
const OPENCODE_PLUGIN_PACKAGE_NAME = "@uniqbit/mate-opencode-plugin";

/**
 * Matches a reference to the retired plugin package: the published spec,
 * a versioned spec, or a path bound to an installed copy. Only for stripping
 * entries older releases wrote into committed config.
 */
export function isLegacyMateOpenCodePluginReference(value: unknown): boolean {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && "package" in value) {
    return isLegacyMateOpenCodePluginReference(value.package);
  }
  if (typeof value !== "string") return false;
  if (
    value === OPENCODE_PLUGIN_PACKAGE_NAME ||
    value.startsWith(`${OPENCODE_PLUGIN_PACKAGE_NAME}@`)
  ) {
    return true;
  }
  return isPreinstalledPluginPath(value, OPENCODE_PLUGIN_PACKAGE_NAME);
}

export function getOpenCodeCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME?.trim() ? env.XDG_CACHE_HOME : path.join(os.homedir(), ".cache");
  return path.join(base, "opencode");
}

export interface WarmPluginCacheResult {
  ok: boolean;
  detail?: string;
}

export const opencodePluginCacheDeps = {
  runInstall: (cwd: string, registry: string) =>
    spawnSync("npm", ["install", "--no-audit", "--no-fund", "--silent", "--registry", registry], {
      cwd,
      encoding: "utf8" as const,
      stdio: ["ignore", "pipe", "pipe"] as const,
    }),
};

export async function warmOpenCodePackageCache(
  packageName: string,
  packageReference: string,
  env: NodeJS.ProcessEnv = process.env,
  registry = PUBLIC_NPM_REGISTRY,
): Promise<WarmPluginCacheResult> {
  if (env.MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH === "1") {
    return { ok: true, detail: "pre-fetch disabled via MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH" };
  }
  const version = packageReference.slice(packageName.length + 1);
  const specDir = path.join(getOpenCodeCacheDir(env), "packages", packageReference);
  try {
    await fs.mkdir(specDir, { recursive: true });
    await fs.writeFile(
      path.join(specDir, "package.json"),
      JSON.stringify({ dependencies: { [packageName]: version } }, null, 2) + "\n",
      "utf8",
    );
    const result = opencodePluginCacheDeps.runInstall(specDir, registry);
    if (result.error) return { ok: false, detail: result.error.message };
    if (result.status !== 0) {
      return {
        ok: false,
        detail: `${result.stderr ?? ""}`.trim() || `npm install exited with ${result.status}`,
      };
    }
    await fs.access(path.join(specDir, "node_modules", ...packageName.split("/"), "package.json"));
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}
