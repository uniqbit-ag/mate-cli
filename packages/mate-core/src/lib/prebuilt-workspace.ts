import fs from "node:fs/promises";
import path from "node:path";

import semver from "semver";

import { OPENCODE_PLUGIN_PACKAGE_NAME } from "./opencode-plugin-package";
import { getCurrentVersion } from "./update-checker";
import {
  CONTEXT_MODE_NODE_REQUIREMENT,
  CONTEXT_MODE_PACKAGE_NAME,
  CONTEXT_MODE_VERSION,
} from "./context-mode-package";
import { getLocalWorkspaceDir } from "./preinstalled-plugins";

/**
 * Packages the distribution selects and pins for the machine-local workspace.
 * A bundle may carry any subset; it may carry nothing else.
 */
export function getDistributionLocalDependencies(): Record<string, string> {
  return {
    [CONTEXT_MODE_PACKAGE_NAME]: CONTEXT_MODE_VERSION,
    [OPENCODE_PLUGIN_PACKAGE_NAME]: getCurrentVersion(),
  };
}

/** Assets a package must carry to count as fully installed rather than merely present. */
const REQUIRED_PACKAGE_ASSETS: Record<string, string[]> = {
  [CONTEXT_MODE_PACKAGE_NAME]: [
    ".claude-plugin/plugin.json",
    "hooks/hooks.json",
    "skills/context-mode/SKILL.md",
    "build/adapters/opencode/plugin.js",
  ],
};

/** Runtime requirement the distribution knows independently of the installed manifest. */
const DECLARED_NODE_REQUIREMENTS: Record<string, string> = {
  [CONTEXT_MODE_PACKAGE_NAME]: CONTEXT_MODE_NODE_REQUIREMENT,
};

export interface PrebuiltWorkspaceTarget {
  platform: string;
  arch: string;
  nodeVersion: string;
}

export interface PrebuiltWorkspaceValidation {
  ok: boolean;
  /** One entry per failure, each naming the package or file it is about. */
  failures: string[];
  /** Installed versions keyed by package name, for comparing one bundle with another. */
  packages: Record<string, string>;
}

export function currentTarget(): PrebuiltWorkspaceTarget {
  return { platform: process.platform, arch: process.arch, nodeVersion: process.versions.node };
}

interface InstalledManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: { node?: string };
  os?: string[];
  cpu?: string[];
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Node's own resolution: nearest `node_modules` first, then each ancestor up to the bundle root. */
async function resolveFromBundle(
  nodeModules: string,
  fromDir: string,
  dependency: string,
): Promise<InstalledManifest | null> {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...dependency.split("/"), "package.json");
    const manifest = await readJson<InstalledManifest>(candidate);
    if (manifest) return manifest;
    if (path.resolve(dir, "node_modules") === path.resolve(nodeModules)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function listInstalledPackages(nodeModules: string): Promise<string[]> {
  const entries = await fs.readdir(nodeModules, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      const scoped = await fs
        .readdir(path.join(nodeModules, entry.name), { withFileTypes: true })
        .catch(() => []);
      for (const child of scoped) {
        if (child.isDirectory() || child.isSymbolicLink())
          names.push(`${entry.name}/${child.name}`);
      }
      continue;
    }
    names.push(entry.name);
  }
  return names;
}

/**
 * Validates an explicitly supplied, fully installed dependency bundle before
 * anything is copied: distribution-owned versions, a complete dependency
 * graph, integrity, target architecture, and runtime compatibility. Nothing is
 * installed, resolved, or downloaded — every answer comes off the filesystem.
 */
export async function validatePrebuiltWorkspace(
  bundlePath: string,
  target: PrebuiltWorkspaceTarget = currentTarget(),
): Promise<PrebuiltWorkspaceValidation> {
  const root = path.resolve(bundlePath);
  const failures: string[] = [];
  const packages: Record<string, string> = {};

  const manifest = await readJson<InstalledManifest>(path.join(root, "package.json"));
  if (!manifest || typeof manifest.dependencies !== "object" || manifest.dependencies === null) {
    return {
      ok: false,
      failures: [`${root}: no framework-generated package.json with a dependencies map.`],
      packages,
    };
  }

  const owned = getDistributionLocalDependencies();
  const nodeModules = path.join(root, "node_modules");

  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const pinned = owned[name];
    if (pinned === undefined) {
      failures.push(`${name}: not a distribution-owned dependency; the bundle may not carry it.`);
      continue;
    }
    if (version !== pinned) {
      failures.push(`${name}: the distribution pins ${pinned}; the bundle declares ${version}.`);
      continue;
    }

    const installed = await readJson<InstalledManifest>(
      path.join(nodeModules, ...name.split("/"), "package.json"),
    );
    if (!installed) {
      failures.push(`${name}: declared by the bundle but not installed in its node_modules.`);
      continue;
    }
    if (installed.version !== pinned) {
      failures.push(
        `${name}: expected ${pinned} installed; found ${installed.version ?? "an unknown version"}.`,
      );
      continue;
    }
    packages[name] = pinned;

    const missingAssets: string[] = [];
    for (const asset of REQUIRED_PACKAGE_ASSETS[name] ?? []) {
      const assetPath = path.join(nodeModules, ...name.split("/"), ...asset.split("/"));
      if (
        !(await fs.access(assetPath).then(
          () => true,
          () => false,
        ))
      )
        missingAssets.push(asset);
    }
    if (missingAssets.length > 0) {
      failures.push(`${name}: installed copy is incomplete; missing ${missingAssets.join(", ")}.`);
    }

    const declaredRequirement = DECLARED_NODE_REQUIREMENTS[name];
    if (declaredRequirement && !semver.satisfies(target.nodeVersion, declaredRequirement)) {
      failures.push(
        `${name}: requires Node.js ${declaredRequirement}; the target runs ${target.nodeVersion}.`,
      );
    }
  }

  for (const name of await listInstalledPackages(nodeModules)) {
    const packageDir = path.join(nodeModules, ...name.split("/"));
    const installed = await readJson<InstalledManifest>(path.join(packageDir, "package.json"));
    if (!installed) {
      failures.push(`${name}: installed directory has no readable package.json.`);
      continue;
    }

    if (
      Array.isArray(installed.os) &&
      installed.os.length > 0 &&
      !installed.os.includes(target.platform)
    ) {
      failures.push(
        `${name}: built for ${installed.os.join(", ")}; the target platform is ${target.platform}.`,
      );
    }
    if (
      Array.isArray(installed.cpu) &&
      installed.cpu.length > 0 &&
      !installed.cpu.includes(target.arch)
    ) {
      failures.push(
        `${name}: built for ${installed.cpu.join(", ")}; the target architecture is ${target.arch}.`,
      );
    }
    if (installed.engines?.node && !semver.satisfies(target.nodeVersion, installed.engines.node)) {
      failures.push(
        `${name}: requires Node.js ${installed.engines.node}; the target runs ${target.nodeVersion}.`,
      );
    }

    for (const dependency of Object.keys(installed.dependencies ?? {})) {
      if (installed.optionalDependencies?.[dependency] !== undefined) continue;
      const resolved = await resolveFromBundle(nodeModules, packageDir, dependency);
      if (!resolved) {
        failures.push(`${dependency}: required by ${name} but not installed in the bundle.`);
      }
    }
  }

  return { ok: failures.length === 0, failures, packages };
}

export { getLocalWorkspaceDir };
