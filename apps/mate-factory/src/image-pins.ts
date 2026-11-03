/**
 * Image pins: the npm locks the image installs from pin the exact tarball of
 * every release package. Release preparation writes the pins from local packs;
 * publication packs again, verifies against the same pins, and publishes that
 * tarball. Both go through this module so they agree on what a pin is.
 *
 * Node built-ins only: publication runs this from a tree it does not install.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Publish order: core precedes the CLI that pins it. */
export const RELEASE_PACKAGES = [
  { name: "@uniqbit/mate-core", dir: "packages/mate-core" },
  { name: "@uniqbit/mate", dir: "apps/mate-cli" },
] as const;

/** Relative to the container root. */
export const IMAGE_LOCKS = [
  {
    manifest: "locks/global-tools.package.json",
    lock: "locks/global-tools.package-lock.json",
  },
  {
    manifest: "locks/local-workspace.package.json",
    lock: "locks/local-workspace.package-lock.json",
  },
] as const;

export type PackedTarball = { tarball: string; integrity: string };

export type StalePin = { name: string; integrity: string; staleLocks: string[] };

export type NpmRunner = (
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => { status: number | null };

export type PackageMetadata = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};

type PackageLockEntry = {
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
};

type PackageLock = {
  packages?: Record<string, PackageLockEntry>;
};

/** Lifecycle output goes to stderr so a caller's stdout stays machine-readable. */
const spawnNpm: NpmRunner = (args, { cwd, env }) =>
  spawnSync("npm", args, { cwd, env, stdio: ["ignore", process.stderr, process.stderr] });

/** Packs each release package once into `dest`, in publish order. */
export function packRelease(
  version: string,
  workspaceRoot: string,
  dest: string,
  { runNpm = spawnNpm }: { runNpm?: NpmRunner } = {},
): Map<string, PackedTarball> {
  const packed = new Map<string, PackedTarball>();
  for (const { name, dir } of RELEASE_PACKAGES) {
    const result = runNpm(["pack", "--pack-destination", dest, "--loglevel", "error"], {
      cwd: path.join(workspaceRoot, dir),
      env: { ...process.env, CI: "1" },
    });
    if (result.status !== 0) throw new Error(`image-pins: packing ${name} failed`);

    const tarball = path.join(dest, tarballName(name, version));
    if (!fs.existsSync(tarball)) {
      throw new Error(`image-pins: npm pack did not create ${path.basename(tarball)} for ${name}`);
    }
    const digest = createHash("sha512").update(fs.readFileSync(tarball)).digest("base64");
    packed.set(name, { tarball, integrity: `sha512-${digest}` });
  }
  return packed;
}

/** The image lock sources, keyed by their `IMAGE_LOCKS` path. */
export function readImageLocks(containerRoot: string): Map<string, string> {
  return new Map(
    IMAGE_LOCKS.map(({ lock }) => [lock, fs.readFileSync(path.join(containerRoot, lock), "utf8")]),
  );
}

/** Release packages no image lock pins. */
export function unpinned(
  lockSources: ReadonlyMap<string, string>,
  names: readonly string[],
): string[] {
  const pins = imagePins(lockSources);
  return names.filter((name) => !pins.some(({ entries }) => entries[`node_modules/${name}`]));
}

/** Packed tarballs some image lock pins at another version or integrity. */
export function stalePins(
  lockSources: ReadonlyMap<string, string>,
  version: string,
  packed: ReadonlyMap<string, PackedTarball>,
): StalePin[] {
  const pins = imagePins(lockSources);
  const stale: StalePin[] = [];
  for (const [name, { integrity }] of packed) {
    const staleLocks = pins
      .filter(({ entries }) => {
        const entry = entries[`node_modules/${name}`];
        return entry && (entry.version !== version || entry.integrity !== integrity);
      })
      .map(({ lock }) => lock);
    if (staleLocks.length > 0) stale.push({ name, integrity, staleLocks });
  }
  return stale;
}

function imagePins(
  lockSources: ReadonlyMap<string, string>,
): { lock: string; entries: Record<string, PackageLockEntry> }[] {
  return IMAGE_LOCKS.flatMap(({ lock }) => {
    const source = lockSources.get(lock);
    if (source === undefined) return [];
    return [{ lock, entries: (JSON.parse(source) as PackageLock).packages ?? {} }];
  });
}

/** A package that tracks the Mate release version. */
function isMatePackage(name: string): boolean {
  return name === "@uniqbit/mate" || name.startsWith("@uniqbit/mate-");
}

/**
 * Rewrites only the `version:` line under `mate:`, so the file keeps its
 * comments — they are most of what makes it readable.
 */
export function withMateVersion(source: string, version: string): string {
  const lines = source.split("\n");
  let inMate = false;
  return lines
    .map((line) => {
      if (/^\S/.test(line)) inMate = /^mate:\s*$/.test(line);
      if (inMate && /^ {2}version:/.test(line)) return `  version: ${version}`;
      return line;
    })
    .join("\n");
}

/** Every dependency in a lock manifest that tracks the Mate release version. */
export function withReleaseVersions(manifest: string, version: string): string {
  const parsed = JSON.parse(manifest) as { dependencies?: Record<string, string> };
  for (const name of Object.keys(parsed.dependencies ?? {})) {
    if (isMatePackage(name)) parsed.dependencies![name] = version;
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** Updates release-owned package entries without querying the not-yet-published version. */
export function withPublishedPackageVersions(
  source: string,
  version: string,
  packages: readonly PackageMetadata[],
  integrities: ReadonlyMap<string, string>,
): string {
  const lock = JSON.parse(source) as PackageLock;
  const entries = lock.packages ?? {};
  const root = entries[""];
  let rewritten = source;

  for (const packageData of packages) {
    const key = `node_modules/${packageData.name}`;
    const entry = entries[key];
    if (!entry) {
      if (root?.dependencies?.[packageData.name] !== undefined) {
        throw new Error(`sync-image-inputs: ${key} is missing from the existing lock`);
      }
      continue;
    }

    const expectedDependencies = { ...packageData.dependencies };
    const actualDependencies = entry.dependencies ?? {};
    if (Object.keys(actualDependencies).some((name) => expectedDependencies[name] === undefined)) {
      throw new Error(
        `sync-image-inputs: ${packageData.name} has stale dependency metadata; regenerate its lock after publication`,
      );
    }
    for (const [name, dependencyVersion] of Object.entries(expectedDependencies)) {
      if (isMatePackage(name)) {
        expectedDependencies[name] = version;
      } else if (actualDependencies[name] !== dependencyVersion) {
        throw new Error(
          `sync-image-inputs: ${packageData.name} changed dependency ${name}; regenerate its lock after publication`,
        );
      }
    }

    const integrity = integrities.get(packageData.name);
    if (!integrity) {
      throw new Error(`sync-image-inputs: no packed integrity for ${packageData.name}`);
    }

    const block = objectBlock(rewritten, key);
    let updatedBlock = replaceProperty(block, "version", entry.version!, version);
    updatedBlock = replaceProperty(
      updatedBlock,
      "resolved",
      entry.resolved!,
      registryTarball(packageData.name, version),
    );
    updatedBlock = replaceProperty(updatedBlock, "integrity", entry.integrity!, integrity);
    for (const [name, dependencyVersion] of Object.entries(expectedDependencies)) {
      const oldVersion = actualDependencies[name];
      if (oldVersion !== dependencyVersion) {
        updatedBlock = replaceProperty(updatedBlock, name, oldVersion!, dependencyVersion);
      }
    }
    rewritten = replaceBlock(rewritten, key, updatedBlock);
  }

  for (const name of Object.keys(root?.dependencies ?? {})) {
    if (isMatePackage(name)) {
      const rootBlock = objectBlock(rewritten, "");
      rewritten = replaceBlock(
        rewritten,
        "",
        replaceProperty(rootBlock, name, root!.dependencies![name], version),
      );
    }
  }

  return rewritten;
}

function objectBlock(source: string, key: string): string {
  const marker = `"${key}": {`;
  const markerStart = source.indexOf(marker);
  if (markerStart === -1) throw new Error(`sync-image-inputs: ${key} is missing from the lock`);
  const objectStart = markerStart + marker.length - 1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = objectStart; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return source.slice(markerStart, index + 1);
  }
  throw new Error(`sync-image-inputs: malformed object for ${key}`);
}

function replaceBlock(source: string, key: string, block: string): string {
  const previous = objectBlock(source, key);
  const start = source.indexOf(previous);
  return `${source.slice(0, start)}${block}${source.slice(start + previous.length)}`;
}

function replaceProperty(source: string, name: string, oldValue: string, newValue: string): string {
  const oldProperty = `${JSON.stringify(name)}: ${JSON.stringify(oldValue)}`;
  const newProperty = `${JSON.stringify(name)}: ${JSON.stringify(newValue)}`;
  if (!source.includes(oldProperty)) {
    throw new Error(`sync-image-inputs: ${name} is missing or changed in the existing lock`);
  }
  return source.replace(oldProperty, newProperty);
}

function registryTarball(name: string, version: string): string {
  const packageName = name.slice(name.indexOf("/") + 1);
  return `https://registry.npmjs.org/${name}/-/${packageName}-${version}.tgz`;
}

function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}
