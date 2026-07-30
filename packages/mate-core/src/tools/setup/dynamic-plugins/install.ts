import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import { dynamicPluginsWorkspaceRoot, pluginPackageRoot } from "./paths";

export type BunInstallRunner = (
  workspaceRoot: string,
) => Promise<{ ok: boolean; detail?: string }> | { ok: boolean; detail?: string };

export type BunUpdateRunner = (
  workspaceRoot: string,
  packages: string[],
) => Promise<{ ok: boolean; detail?: string }> | { ok: boolean; detail?: string };

export interface PluginInstallDeps {
  runBunInstall?: BunInstallRunner;
  runBunUpdate?: BunUpdateRunner;
}

export interface PluginInstallResult {
  package: string;
  status: "installed" | "unchanged" | "failed";
  resolvedVersion?: string;
  error?: string;
}

/** Runs `bun install` for the shared plugin workspace, honoring the user's ambient registry/auth config. */
function defaultBunInstall(workspaceRoot: string): { ok: boolean; detail?: string } {
  const result = spawnSync("bun", ["install", "--silent"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
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

/** Runs `bun update <pkg...>` to force re-resolution of `latest`-declared plugins every run. */
function defaultBunUpdate(
  workspaceRoot: string,
  packages: string[],
): { ok: boolean; detail?: string } {
  const result = spawnSync("bun", ["update", "--silent", ...packages], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      detail:
        result.error?.message ?? result.stderr?.trim() ?? `bun update exited with ${result.status}`,
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
 * `.mate/dependencies/plugins/`. Builds a single `dependencies` map (package
 * → declared version, sorted by name) and diffs it against the workspace's
 * current `package.json` plus each package's actual installed presence; an
 * identical, fully-installed map with no `latest` declaration skips the
 * install entirely. Otherwise the map is written and `bun install` runs once
 * for the whole workspace. `latest`-declared plugins additionally get a `bun
 * update` every run, regardless of whether the map changed, so they
 * re-resolve on every run. The shared, committed `bun.lock` is the sole
 * reproducibility record; nothing else pins versions.
 */
export async function installDeclaredPlugins(
  companionPath: string,
  declarations: PluginDeclaration[],
  deps: PluginInstallDeps = {},
): Promise<PluginInstallResult[]> {
  const runBunInstall = deps.runBunInstall ?? defaultBunInstall;
  const runBunUpdate = deps.runBunUpdate ?? defaultBunUpdate;
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

  const latestPackages = sorted
    .filter((declaration) => declaration.version === "latest")
    .map((declaration) => declaration.package);
  const manifestMatches = JSON.stringify(desired) === JSON.stringify(current);
  const allInstalled = installedBefore.every((version) => version !== null);
  const unchanged = latestPackages.length === 0 && manifestMatches && allInstalled;

  if (unchanged) {
    return sorted.map((declaration, index) => ({
      package: declaration.package,
      status: "unchanged",
      resolvedVersion: installedBefore[index] ?? undefined,
    }));
  }

  await writeWorkspaceManifest(workspaceRoot, desired);
  const installOutcome = await runBunInstall(workspaceRoot);
  const installFailure = installOutcome.ok
    ? undefined
    : (installOutcome.detail ?? "bun install failed");

  let updateFailure: string | undefined;
  if (latestPackages.length > 0) {
    const updateOutcome = await runBunUpdate(workspaceRoot, latestPackages);
    updateFailure = updateOutcome.ok ? undefined : (updateOutcome.detail ?? "bun update failed");
  }

  const resolvedVersions = await Promise.all(
    sorted.map((declaration) =>
      readInstalledVersion(pluginPackageRoot(companionPath, declaration.package)),
    ),
  );

  return sorted.map((declaration, index) => {
    const isLatest = declaration.version === "latest";
    const failure = installFailure ?? (isLatest ? updateFailure : undefined);
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
