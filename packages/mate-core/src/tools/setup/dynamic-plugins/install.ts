import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import { dynamicPluginsWorkspaceRoot, pluginPackageRoot } from "./paths";

export type NpmInstallRunner = (
  workspaceRoot: string,
) => Promise<{ ok: boolean; detail?: string }> | { ok: boolean; detail?: string };

export type NpmUpdateRunner = (
  workspaceRoot: string,
  packages: string[],
) => Promise<{ ok: boolean; detail?: string }> | { ok: boolean; detail?: string };

export interface PluginInstallDeps {
  runNpmInstall?: NpmInstallRunner;
  runNpmUpdate?: NpmUpdateRunner;
}

export interface PluginInstallResult {
  package: string;
  status: "installed" | "unchanged" | "failed";
  resolvedVersion?: string;
  error?: string;
}

/** Runs `npm install` for the shared plugin workspace, honoring the user's ambient registry/auth config. */
function defaultNpmInstall(workspaceRoot: string): { ok: boolean; detail?: string } {
  const result = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--silent"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      detail:
        result.error?.message ??
        result.stderr?.trim() ??
        `npm install exited with ${result.status}`,
    };
  }
  return { ok: true };
}

/** Version literals treated as moving targets: re-resolved via `npm update` on every run. */
const MOVING_VERSION_TAGS = new Set(["latest", "canary"]);

/** Runs `npm update <pkg...>` to force re-resolution of moving-tag-declared plugins every run. */
function defaultNpmUpdate(
  workspaceRoot: string,
  packages: string[],
): { ok: boolean; detail?: string } {
  const result = spawnSync("npm", ["update", "--no-audit", "--no-fund", "--silent", ...packages], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      detail:
        result.error?.message ?? result.stderr?.trim() ?? `npm update exited with ${result.status}`,
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

async function readWorkspaceDependencies(workspaceRoot: string): Promise<Record<string, string>> {
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    return manifest.dependencies ?? {};
  } catch {
    return {};
  }
}

async function writeWorkspaceManifest(
  workspaceRoot: string,
  dependencies: Record<string, string>,
): Promise<void> {
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify({ private: true, dependencies }, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Installs every declared plugin into one shared workspace at
 * `.mate/plugins/`. Builds a single `dependencies` map (package
 * → declared version, sorted by name) and diffs it against the workspace's
 * current `package.json` plus each package's actual installed presence; an
 * identical, fully-installed map with no moving-tag declaration (`latest` or
 * `canary`) skips the install entirely. Otherwise the map is written and
 * `npm install` runs once for the whole workspace. Moving-tag-declared
 * plugins additionally get an `npm update` every run, regardless of whether
 * the map changed, so they re-resolve on every run. The shared, committed
 * `package-lock.json` is the sole reproducibility record; nothing else pins
 * versions. Private
 * registries are never Mate's concern: installs run through the operator's
 * own ambient npm config, or a project-local, gitignored `.npmrc` dropped
 * next to the workspace's `package.json`.
 */
export async function installDeclaredPlugins(
  companionPath: string,
  declarations: PluginDeclaration[],
  deps: PluginInstallDeps = {},
): Promise<PluginInstallResult[]> {
  const runNpmInstall = deps.runNpmInstall ?? defaultNpmInstall;
  const runNpmUpdate = deps.runNpmUpdate ?? defaultNpmUpdate;
  const workspaceRoot = dynamicPluginsWorkspaceRoot(companionPath);

  const sorted = declarations.toSorted((a, b) => a.package.localeCompare(b.package));
  const desired: Record<string, string> = {};
  for (const declaration of sorted) desired[declaration.package] = declaration.version;

  const [current, installedBefore] = await Promise.all([
    readWorkspaceDependencies(workspaceRoot),
    Promise.all(
      sorted.map((declaration) =>
        readInstalledVersion(pluginPackageRoot(companionPath, declaration.package)),
      ),
    ),
  ]);

  const movingPackages = sorted
    .filter((declaration) => MOVING_VERSION_TAGS.has(declaration.version))
    .map((declaration) => declaration.package);
  const manifestMatches = JSON.stringify(desired) === JSON.stringify(current);
  const allInstalled = installedBefore.every((version) => version !== null);
  const unchanged = movingPackages.length === 0 && manifestMatches && allInstalled;

  if (unchanged) {
    return sorted.map((declaration, index) => ({
      package: declaration.package,
      status: "unchanged",
      resolvedVersion: installedBefore[index] ?? undefined,
    }));
  }

  await writeWorkspaceManifest(workspaceRoot, desired);
  const installOutcome = await runNpmInstall(workspaceRoot);
  const installFailure = installOutcome.ok
    ? undefined
    : (installOutcome.detail ?? "npm install failed");

  let updateFailure: string | undefined;
  if (movingPackages.length > 0) {
    const updateOutcome = await runNpmUpdate(workspaceRoot, movingPackages);
    updateFailure = updateOutcome.ok ? undefined : (updateOutcome.detail ?? "npm update failed");
  }

  const resolvedVersions = await Promise.all(
    sorted.map((declaration) =>
      readInstalledVersion(pluginPackageRoot(companionPath, declaration.package)),
    ),
  );

  return sorted.map((declaration, index) => {
    const isMoving = MOVING_VERSION_TAGS.has(declaration.version);
    const failure = installFailure ?? (isMoving ? updateFailure : undefined);
    if (failure) {
      return { package: declaration.package, status: "failed", error: failure };
    }
    const resolvedVersion = resolvedVersions[index];
    if (!resolvedVersion) {
      return {
        package: declaration.package,
        status: "failed",
        error: `installed tree is missing ${declaration.package}/package.json`,
      };
    }
    return { package: declaration.package, status: "installed", resolvedVersion };
  });
}
