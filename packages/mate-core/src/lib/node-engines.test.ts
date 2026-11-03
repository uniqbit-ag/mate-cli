import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import semver from "semver";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const cliRoot = path.join(repoRoot, "apps", "mate-cli");
const coreRoot = path.join(repoRoot, "packages", "mate-core");

interface Manifest {
  name: string;
  version: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function readManifest(file: string): Manifest {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
}

function resolveManifest(name: string, fromDir: string): string | null {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", ...name.split("/"), "package.json");
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * Every package `npm i -g @uniqbit/mate` installs: dependencies, optional
 * dependencies and the peers npm installs on its own (the non-optional ones).
 */
function installedTree(rootManifest: string): Manifest[] {
  const seen = new Map<string, Manifest>();
  const visit = (file: string): void => {
    const real = fs.realpathSync(file);
    if (seen.has(real)) return;
    const manifest = readManifest(real);
    seen.set(real, manifest);
    const names = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(
        (name) => !manifest.peerDependenciesMeta?.[name]?.optional,
      ),
    ];
    for (const name of names) {
      const resolved = resolveManifest(name, path.dirname(real));
      if (resolved) visit(resolved);
    }
  };
  visit(rootManifest);
  return [...seen.values()];
}

describe("declared Node version", () => {
  const declared = readManifest(path.join(cliRoot, "package.json")).engines?.node;

  test("is the same range for the workspace, the CLI and mate-core", () => {
    expect(declared).toBeDefined();
    expect(readManifest(path.join(repoRoot, "package.json")).engines?.node).toBe(declared);
    expect(readManifest(path.join(coreRoot, "package.json")).engines?.node).toBe(declared);
  });

  test("covers the Node APIs the Claude hooks' TypeScript loader needs", () => {
    // module.registerHooks and module.stripTypeScriptTypes: Node 22.15.
    expect(semver.gte(semver.minVersion(declared!)!, "22.15.0")).toBe(true);
  });

  test("satisfies every installed dependency's engines.node, so npm prints no EBADENGINE", () => {
    const minimum = semver.minVersion(declared!)!.version;
    const conflicts = installedTree(path.join(cliRoot, "package.json"))
      .filter(
        (manifest) => manifest.name !== "@uniqbit/mate" && manifest.name !== "@uniqbit/mate-core",
      )
      .filter((manifest) => manifest.engines?.node)
      .filter((manifest) => !semver.satisfies(minimum, manifest.engines!.node!))
      .map((manifest) => `${manifest.name}@${manifest.version} (node ${manifest.engines!.node})`);

    expect(conflicts).toEqual([]);
  });
});
