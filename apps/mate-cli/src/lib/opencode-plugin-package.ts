import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCurrentVersion } from "./update-checker";

export const OPENCODE_PLUGIN_PACKAGE_NAME = "@uniqbit/mate-opencode-plugin";

/**
 * The plugin package reference configured for OpenCode. All public Mate
 * packages are released in lockstep with synchronized versions, so the pinned
 * plugin version is derived from the CLI's own version instead of a separate
 * compatibility range.
 */
export function getOpenCodePluginPackageReference(version: string = getCurrentVersion()): string {
  return `${OPENCODE_PLUGIN_PACKAGE_NAME}@${version}`;
}

export function isMateOpenCodePluginReference(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value === OPENCODE_PLUGIN_PACKAGE_NAME || value.startsWith(`${OPENCODE_PLUGIN_PACKAGE_NAME}@`))
  );
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
  runInstall: (cwd: string) =>
    spawnSync("npm", ["install", "--no-audit", "--no-fund", "--silent"], {
      cwd,
      encoding: "utf8" as const,
      stdio: ["ignore", "pipe", "pipe"] as const,
    }),
};

/**
 * Pre-fetch the pinned plugin package into OpenCode's npm plugin environment
 * (`<cache>/packages/<spec>/`), mirroring OpenCode's own on-demand install
 * layout, so the first managed launch after a setup or update does not depend
 * on registry access. Best effort: failures are reported, never thrown.
 */
export async function warmOpenCodePluginCache(
  version: string = getCurrentVersion(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<WarmPluginCacheResult> {
  // Escape hatch for tests and intentionally offline environments: skip the
  // pre-fetch entirely instead of attempting a registry install.
  if (env.MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH === "1") {
    return { ok: true, detail: "pre-fetch disabled via MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH" };
  }

  const reference = getOpenCodePluginPackageReference(version);
  const specDir = path.join(getOpenCodeCacheDir(env), "packages", reference);

  try {
    await fs.mkdir(specDir, { recursive: true });
    await fs.writeFile(
      path.join(specDir, "package.json"),
      JSON.stringify({ dependencies: { [OPENCODE_PLUGIN_PACKAGE_NAME]: version } }, null, 2) + "\n",
      "utf8",
    );

    const result = opencodePluginCacheDeps.runInstall(specDir);
    if (result.error) {
      return { ok: false, detail: result.error.message };
    }
    if (result.status !== 0) {
      const output = `${result.stderr ?? ""}`.trim() || `npm install exited with ${result.status}`;
      return { ok: false, detail: output };
    }

    await fs.access(
      path.join(
        specDir,
        "node_modules",
        ...OPENCODE_PLUGIN_PACKAGE_NAME.split("/"),
        "package.json",
      ),
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}
