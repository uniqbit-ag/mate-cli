import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import { pluginInstallDir, pluginPackageRoot } from "./paths";
import { PluginPinStore, type PluginPin } from "./pin-store";

export type BunInstallRunner = (
  installDir: string,
) => Promise<{ ok: boolean; detail?: string }> | { ok: boolean; detail?: string };

export interface PluginInstallDeps {
  runBunInstall?: BunInstallRunner;
}

export interface PluginInstallResult {
  package: string;
  status: "installed" | "unchanged" | "failed";
  resolvedVersion?: string;
  error?: string;
}

/** Runs `bun install` in the plugin workspace, honoring the user's ambient registry/auth config. */
function defaultBunInstall(installDir: string): { ok: boolean; detail?: string } {
  const result = spawnSync("bun", ["install", "--silent"], { cwd: installDir, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      detail:
        result.error?.message ??
        result.stderr?.trim() ??
        `bun install exited with ${result.status}`,
    };
  }
  return { ok: true };
}

async function readInstalledVersion(packageRoot: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as { version?: string };
    return manifest.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort integrity extraction from bun's text lockfile. The lockfile is
 * JSONC (trailing commas); package entries are tuples whose last string is
 * the registry integrity hash. Absence is tolerated per spec.
 */
async function readIntegrityFromBunLock(
  installDir: string,
  packageName: string,
): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(installDir, "bun.lock"), "utf8");
    const parsed = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1")) as {
      packages?: Record<string, unknown>;
    };
    const entry = parsed.packages?.[packageName];
    if (!Array.isArray(entry)) return undefined;
    return entry.find(
      (element): element is string => typeof element === "string" && element.startsWith("sha"),
    );
  } catch {
    return undefined;
  }
}

/**
 * Installs each declared plugin into `.mate/dependencies/plugins/<sanitized>/`
 * and records `{ package, declaredVersion, resolvedVersion, integrity }` in
 * the committed pin file. Exact/range versions resolve once and stay pinned
 * until the declaration changes; `latest` re-resolves on every run. Matching
 * pinned installs are left untouched.
 */
export async function installDeclaredPlugins(
  companionPath: string,
  declarations: PluginDeclaration[],
  deps: PluginInstallDeps = {},
): Promise<PluginInstallResult[]> {
  const runBunInstall = deps.runBunInstall ?? defaultBunInstall;
  const pinStore = new PluginPinStore(companionPath);
  const previousPins = (await pinStore.load()).plugins;
  const nextPins: PluginPin[] = [];
  const results: PluginInstallResult[] = [];

  for (const declaration of declarations) {
    const pin = previousPins.find((candidate) => candidate.package === declaration.package);
    const installDir = pluginInstallDir(companionPath, declaration.package);
    const packageRoot = pluginPackageRoot(companionPath, declaration.package);
    // oxlint-disable-next-line no-await-in-loop -- installs mutate a shared pin file sequentially
    const installedVersion = await readInstalledVersion(packageRoot);

    const pinMatches =
      declaration.version !== "latest" &&
      pin !== undefined &&
      pin.declaredVersion === declaration.version &&
      installedVersion === pin.resolvedVersion;
    if (pinMatches) {
      nextPins.push(pin);
      results.push({
        package: declaration.package,
        status: "unchanged",
        resolvedVersion: pin.resolvedVersion,
      });
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop
    const result = await installOne(installDir, packageRoot, declaration, runBunInstall);
    results.push(result);
    if (result.status === "installed" && result.resolvedVersion) {
      nextPins.push({
        package: declaration.package,
        declaredVersion: declaration.version,
        resolvedVersion: result.resolvedVersion,
        // oxlint-disable-next-line no-await-in-loop
        integrity: await readIntegrityFromBunLock(installDir, declaration.package),
      });
    }
  }

  // Pins mirror the declaration list; undeclared packages drop out.
  if (JSON.stringify(nextPins) !== JSON.stringify(previousPins)) {
    await pinStore.save({ plugins: nextPins });
  }
  return results;
}

async function installOne(
  installDir: string,
  packageRoot: string,
  declaration: PluginDeclaration,
  runBunInstall: BunInstallRunner,
): Promise<PluginInstallResult> {
  try {
    // Fresh workspace per (re)install so `latest` and edited declarations
    // actually re-resolve instead of reusing a stale lockfile.
    await fs.rm(installDir, { recursive: true, force: true });
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      path.join(installDir, "package.json"),
      JSON.stringify(
        { private: true, dependencies: { [declaration.package]: declaration.version } },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const outcome = await runBunInstall(installDir);
    if (!outcome.ok) {
      throw new Error(outcome.detail ?? "bun install failed");
    }
    const resolvedVersion = await readInstalledVersion(packageRoot);
    if (!resolvedVersion) {
      throw new Error(`installed tree is missing ${declaration.package}/package.json`);
    }
    return { package: declaration.package, status: "installed", resolvedVersion };
  } catch (error) {
    return {
      package: declaration.package,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
