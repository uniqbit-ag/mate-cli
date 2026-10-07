import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import type { NpmInstallRunner, PluginInstallResult } from "./install";
import { dynamicPluginsWorkspaceRoot } from "./paths";

/** Raised before anything is installed: manifest or lockfile inputs are unusable. */
export class FrozenInstallError extends Error {}

export interface FrozenInstallDeps {
  /** Restores the exact locked tree; defaults to `npm ci`. */
  runNpmCi?: NpmInstallRunner;
  env?: Record<string, string | undefined>;
}

interface LockEntry {
  version?: string;
  integrity?: string;
  optional?: boolean;
  inBundle?: boolean;
  link?: boolean;
}

interface Lockfile {
  packages?: Record<string, LockEntry & { dependencies?: Record<string, string> }>;
}

function defaultNpmCi(workspaceRoot: string): { ok: boolean; detail?: string } {
  const result = spawnSync("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      detail:
        result.error?.message ?? (result.stderr?.trim() || `npm ci exited with ${result.status}`),
    };
  }
  return { ok: true };
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FrozenInstallError(`${label} is not valid JSON`);
  }
}

function sameMap(a: Record<string, string>, b: Record<string, string>): string[] {
  const differences: string[] = [];
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[name] !== b[name]) {
      differences.push(
        `${name} (declared ${a[name] ?? "absent"}, recorded ${b[name] ?? "absent"})`,
      );
    }
  }
  return differences.toSorted();
}

/**
 * Compares the installed tree's hidden lockfile with the committed lockfile:
 * every non-optional locked package must be installed at the locked version
 * and integrity, and nothing extra may be installed. Package presence alone
 * proves nothing.
 */
async function treeMismatches(workspaceRoot: string, lock: Lockfile): Promise<string[]> {
  const hiddenText = await readText(path.join(workspaceRoot, "node_modules", ".package-lock.json"));
  if (hiddenText === null) return ["installed tree has no install record"];
  let hidden: Lockfile;
  try {
    hidden = JSON.parse(hiddenText) as Lockfile;
  } catch {
    return ["installed tree's install record is unreadable"];
  }
  const installed = hidden.packages ?? {};
  const mismatches: string[] = [];
  for (const [key, locked] of Object.entries(lock.packages ?? {})) {
    if (key === "" || locked.link) continue;
    const present = installed[key];
    if (!present) {
      if (!locked.optional) mismatches.push(`${key} is not installed`);
      continue;
    }
    if (present.version !== locked.version || present.integrity !== locked.integrity) {
      mismatches.push(`${key} differs from the lockfile`);
    }
  }
  for (const key of Object.keys(installed)) {
    if (!lock.packages?.[key]) mismatches.push(`${key} is installed but not locked`);
  }
  return mismatches;
}

/**
 * Deployment restore: installs exactly what the committed lockfile records.
 * Inputs are validated before npm runs — the workspace manifest against the declarations, and the lockfile against the
 * manifest — and neither tracked file is ever rewritten. An installed tree is
 * reused only when it matches the lockfile's versions and integrity.
 */
export async function installDeclaredPluginsFrozen(
  companionPath: string,
  declarations: PluginDeclaration[],
  deps: FrozenInstallDeps = {},
): Promise<PluginInstallResult[]> {
  const workspaceRoot = dynamicPluginsWorkspaceRoot(companionPath);
  const sorted = declarations.toSorted((a, b) => a.package.localeCompare(b.package));
  const desired: Record<string, string> = {};
  for (const declaration of sorted) desired[declaration.package] = declaration.version;

  const manifestFile = path.join(workspaceRoot, "package.json");
  const lockFile = path.join(workspaceRoot, "package-lock.json");
  const [manifestText, lockText] = await Promise.all([readText(manifestFile), readText(lockFile)]);
  if (manifestText === null) {
    throw new FrozenInstallError(
      `${manifestFile} is missing; commit the plugin workspace manifest in the companion's authoring flow`,
    );
  }
  if (lockText === null) {
    throw new FrozenInstallError(
      `${lockFile} is missing; commit the plugin lockfile in the companion's authoring flow`,
    );
  }

  const manifest = parseJson<{ dependencies?: Record<string, string> }>(manifestText, manifestFile);
  const manifestDrift = sameMap(desired, manifest.dependencies ?? {});
  if (manifestDrift.length > 0) {
    throw new FrozenInstallError(
      `plugin workspace manifest disagrees with framework.yaml: ${manifestDrift.join("; ")}`,
    );
  }
  const lock = parseJson<Lockfile>(lockText, lockFile);
  const lockRoot = lock.packages?.[""]?.dependencies ?? {};
  const lockDrift = sameMap(desired, lockRoot);
  if (lockDrift.length > 0) {
    throw new FrozenInstallError(
      `plugin lockfile disagrees with framework.yaml: ${lockDrift.join("; ")}`,
    );
  }
  const unlocked = sorted.filter((declaration) => {
    const entry = lock.packages?.[`node_modules/${declaration.package}`];
    return !entry?.version || !entry.integrity;
  });
  if (unlocked.length > 0) {
    throw new FrozenInstallError(
      `plugin lockfile has no resolved version and integrity for: ${unlocked.map((d) => d.package).join(", ")}`,
    );
  }

  const lockedVersion = (name: string) => lock.packages?.[`node_modules/${name}`]?.version;
  const fail = (error: string): PluginInstallResult[] =>
    sorted.map((declaration) => ({ package: declaration.package, status: "failed", error }));

  if ((await treeMismatches(workspaceRoot, lock)).length === 0) {
    return sorted.map((declaration) => ({
      package: declaration.package,
      status: "unchanged",
      resolvedVersion: lockedVersion(declaration.package),
    }));
  }

  const outcome = await (deps.runNpmCi ?? defaultNpmCi)(workspaceRoot);
  if (!outcome.ok) return fail(outcome.detail ?? "npm ci failed");

  const [manifestAfter, lockAfter] = await Promise.all([
    readText(manifestFile),
    readText(lockFile),
  ]);
  if (manifestAfter !== manifestText || lockAfter !== lockText) {
    await Promise.all([fs.writeFile(manifestFile, manifestText), fs.writeFile(lockFile, lockText)]);
    return fail("the restore changed the committed manifest or lockfile; they were put back");
  }
  const remaining = await treeMismatches(workspaceRoot, lock);
  if (remaining.length > 0) {
    return fail(`installed tree does not match the lockfile: ${remaining.join("; ")}`);
  }
  return sorted.map((declaration) => ({
    package: declaration.package,
    status: "installed",
    resolvedVersion: lockedVersion(declaration.package),
  }));
}
