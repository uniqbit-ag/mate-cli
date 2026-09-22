#!/usr/bin/env bun
/**
 * Release hook: keep the image's release-owned inputs at the version being
 * released, and update the npm locks against local release tarballs.
 *
 * The image installs the published package, so its inputs have to name the
 * release they belong to before the release commit is made. The packages are
 * not on the registry yet at this point; packing locally supplies their exact
 * integrity while the existing lock supplies the already-resolved transitive graph.
 *
 *   bun scripts/sync-image-inputs.ts <version> [workspace-root]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { IMAGE_INPUTS_FILE, readImageInputs } from "../src/image-inputs";

export const LOCK_MANIFESTS = [
  "locks/global-tools.package.json",
  "locks/local-workspace.package.json",
] as const;

const PUBLIC_PACKAGES = [
  ["@uniqbit/mate-core", "packages/mate-core"],
  ["@uniqbit/mate-opencode-plugin", "apps/mate-opencode-plugin"],
  ["@uniqbit/mate", "apps/mate-cli"],
] as const;

type PackageMetadata = {
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

/** Keeps the prebuilt plugin bundle on the same release as the image. */
export function withPrebuiltPluginVersion(source: string, version: string): string {
  return source.replace(/^(    "@uniqbit\/mate-opencode-plugin": )[^\n]+$/m, `$1${version}`);
}

/** Every dependency in a lock manifest that tracks the Mate release version. */
export function withReleaseVersions(manifest: string, version: string): string {
  const parsed = JSON.parse(manifest) as { dependencies?: Record<string, string> };
  for (const name of Object.keys(parsed.dependencies ?? {})) {
    if (name === "@uniqbit/mate" || name.startsWith("@uniqbit/mate-")) {
      parsed.dependencies![name] = version;
    }
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
      if (name === "@uniqbit/mate" || name.startsWith("@uniqbit/mate-")) {
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
    if (name === "@uniqbit/mate" || name.startsWith("@uniqbit/mate-")) {
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

function packageFileName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

function readPackageMetadata(packageRoot: string): PackageMetadata {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
}

function packIntegrities(
  packages: readonly PackageMetadata[],
  packageRoots: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mate-release-packages-"));
  const integrities = new Map<string, string>();

  try {
    for (const packageData of packages) {
      const packageRoot = packageRoots.get(packageData.name);
      if (!packageRoot) throw new Error(`sync-image-inputs: no root for ${packageData.name}`);

      const result = spawnSync(
        "npm",
        ["pack", "--pack-destination", scratch, "--loglevel", "error"],
        {
          cwd: packageRoot,
          env: { ...process.env, CI: "1" },
          stdio: "inherit",
        },
      );
      if (result.status !== 0) {
        throw new Error(`sync-image-inputs: packing ${packageData.name} failed`);
      }

      const archive = path.join(scratch, packageFileName(packageData.name, packageData.version));
      if (!fs.existsSync(archive)) {
        throw new Error(`sync-image-inputs: npm pack did not create ${path.basename(archive)}`);
      }
      const integrity = createHash("sha512").update(fs.readFileSync(archive)).digest("base64");
      integrities.set(packageData.name, `sha512-${integrity}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  return integrities;
}

function main(argv: string[]): number {
  const version = argv[0];
  if (!version) {
    process.stderr.write("sync-image-inputs: a version is required\n");
    return 1;
  }
  const containerRoot = argv[1]
    ? path.resolve(argv[1], "apps", "mate-container")
    : path.resolve(import.meta.dirname, "..");
  const workspaceRoot = path.resolve(containerRoot, "..", "..");
  const inputsFile = path.join(containerRoot, path.basename(IMAGE_INPUTS_FILE));

  const packageRoots = new Map(
    PUBLIC_PACKAGES.map(([name, relative]) => [name, path.join(workspaceRoot, relative)]),
  );
  const packages = PUBLIC_PACKAGES.map(([name]) => readPackageMetadata(packageRoots.get(name)!));
  if (packages.some((packageData) => packageData.version !== version)) {
    process.stderr.write(`sync-image-inputs: public packages are not all at ${version}\n`);
    return 1;
  }
  const integrities = packIntegrities(packages, packageRoots);

  const outputs = new Map<string, string>();
  outputs.set(
    inputsFile,
    withPrebuiltPluginVersion(
      withMateVersion(fs.readFileSync(inputsFile, "utf8"), version),
      version,
    ),
  );

  for (const relative of LOCK_MANIFESTS) {
    const manifest = path.join(containerRoot, relative);
    const manifestSource = withReleaseVersions(fs.readFileSync(manifest, "utf8"), version);
    const stem = path.basename(manifest, ".package.json");
    const lock = path.join(path.dirname(manifest), `${stem}.package-lock.json`);

    outputs.set(manifest, manifestSource);
    outputs.set(
      lock,
      withPublishedPackageVersions(fs.readFileSync(lock, "utf8"), version, packages, integrities),
    );
  }

  for (const [file, contents] of outputs) fs.writeFileSync(file, contents);

  const touched = [...outputs.keys()];

  const added = spawnSync("git", ["add", ...touched], { stdio: "inherit" });
  if (added.status !== 0) {
    process.stderr.write("sync-image-inputs: git add failed\n");
    return added.status ?? 1;
  }

  const inputs = readImageInputs(inputsFile);
  process.stdout.write(`sync-image-inputs: image inputs pinned to ${inputs.mate.version}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
