import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { parse } from "yaml";

import { fakePluginInstallDeps } from "../../../../test/plugin-install";
import { FrozenInstallError } from "./frozen";
import type { NpmInstallRunner } from "./install";
import { dynamicPluginsWorkspaceRoot, pluginPackageRoot } from "./paths";
import {
  AUDIENCE_WORKSPACES_VERSION,
  describeRemovedAudience,
  installPluginWorkspaces,
  linkSharedNpmrc,
  removeUnselectedAudienceTrees,
} from "./workspaces";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const BASE = { package: "@acme/base", version: "^1.0.0" };
const READER = { package: "@acme/reader", version: "^1.0.0" };
const TESTER = { package: "@acme/tester", version: "^1.0.0" };
const CONFIG = {
  plugins: [BASE],
  audiences: { ba: { plugins: [READER] }, qa: { plugins: [TESTER] } },
};
const INTEGRITY = "sha512-a";

async function companion(config: unknown = CONFIG): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-workspaces-"));
  roots.push(dir);
  await fs.mkdir(path.join(dir, ".mate", "config"), { recursive: true });
  await fs.writeFile(path.join(dir, ".mate", "config", "framework.yaml"), JSON.stringify(config));
  return dir;
}

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

async function readDependencies(workspaceRoot: string): Promise<Record<string, string>> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  return manifest.dependencies;
}

/**
 * Simulates `npm install`: materializes every dependency of the manifest,
 * prunes the rest and writes the lockfile and the tree's install record.
 */
function fakeNpm(): { runner: NpmInstallRunner; calls: string[]; npmrc: Array<string | null> } {
  const calls: string[] = [];
  const npmrc: Array<string | null> = [];
  return {
    calls,
    npmrc,
    runner: async (workspaceRoot) => {
      calls.push(workspaceRoot);
      npmrc.push(await fs.readFile(path.join(workspaceRoot, ".npmrc"), "utf8").catch(() => null));
      const dependencies = await readDependencies(workspaceRoot);
      const modules = path.join(workspaceRoot, "node_modules");
      await fs.rm(modules, { recursive: true, force: true });
      const locked: Record<string, unknown> = { "": { dependencies } };
      const installed: Record<string, unknown> = {};
      for (const name of Object.keys(dependencies)) {
        const packageRoot = path.join(modules, ...name.split("/"));
        await fs.mkdir(packageRoot, { recursive: true });
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name, version: "1.2.0" }),
        );
        const entry = { version: "1.2.0", integrity: INTEGRITY };
        locked[`node_modules/${name}`] = entry;
        installed[`node_modules/${name}`] = entry;
      }
      await fs.writeFile(
        path.join(workspaceRoot, "package-lock.json"),
        JSON.stringify({ lockfileVersion: 3, packages: locked }),
      );
      if (Object.keys(installed).length > 0) {
        await fs.writeFile(
          path.join(modules, ".package-lock.json"),
          JSON.stringify({ packages: installed }),
        );
      }
      return { ok: true };
    },
  };
}

function install(
  companionPath: string,
  audience: string | null,
  npm = fakeNpm(),
  config: unknown = CONFIG,
) {
  return installPluginWorkspaces(companionPath, config, audience, {
    installDeps: fakePluginInstallDeps({ runNpmInstall: npm.runner }),
  });
}

/** Restores a tree from the committed lockfile, as `npm ci` does. */
const fakeNpmCi: NpmInstallRunner = async (workspaceRoot) => {
  const lock = JSON.parse(
    await fs.readFile(path.join(workspaceRoot, "package-lock.json"), "utf8"),
  ) as { packages: Record<string, unknown> };
  const modules = path.join(workspaceRoot, "node_modules");
  await fs.mkdir(modules, { recursive: true });
  const { "": _root, ...installed } = lock.packages;
  await fs.writeFile(
    path.join(modules, ".package-lock.json"),
    JSON.stringify({ packages: installed }),
  );
  return { ok: true };
};

function restore(companionPath: string, audience: string | null, config: unknown = CONFIG) {
  return installPluginWorkspaces(companionPath, config, audience, {
    frozen: true,
    frozenDeps: { runNpmCi: fakeNpmCi, env: {} },
  });
}

async function trackedFiles(companionPath: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.name === "node_modules" || entry.name === ".npmrc") continue;
      if (entry.isDirectory()) await walk(file);
      else files[path.relative(companionPath, file)] = await fs.readFile(file, "utf8");
    }
  };
  await walk(path.join(companionPath, ".mate"));
  return files;
}

describe("installPluginWorkspaces", () => {
  test("without an audience no audience plugin is installed anywhere", async () => {
    const dir = await companion();
    const npm = fakeNpm();

    const outcome = await install(dir, null, npm);

    expect(outcome.results.map((result) => result.package)).toEqual(["@acme/base"]);
    expect(npm.calls).toEqual([dynamicPluginsWorkspaceRoot(dir)]);
    expect(await readDependencies(dynamicPluginsWorkspaceRoot(dir))).toEqual({
      "@acme/base": "^1.0.0",
    });
    expect(await exists(path.join(dir, ".mate", "plugins", "audiences"))).toBe(false);
    expect(await exists(pluginPackageRoot(dir, "@acme/reader"))).toBe(false);
  });

  test("the selected audience installs into its own workspace with its own lockfile", async () => {
    const dir = await companion();

    const outcome = await install(dir, "ba");

    expect(outcome.results.map((result) => [result.package, result.status])).toEqual([
      ["@acme/base", "installed"],
      ["@acme/reader", "installed"],
    ]);
    const shared = dynamicPluginsWorkspaceRoot(dir);
    const ba = dynamicPluginsWorkspaceRoot(dir, "ba");
    expect(await readDependencies(shared)).toEqual({ "@acme/base": "^1.0.0" });
    expect(await readDependencies(ba)).toEqual({ "@acme/reader": "^1.0.0" });
    expect(await exists(pluginPackageRoot(dir, "@acme/reader", "ba"))).toBe(true);
    expect(await exists(pluginPackageRoot(dir, "@acme/reader"))).toBe(false);
    const sharedLock = await fs.readFile(path.join(shared, "package-lock.json"), "utf8");
    const baLock = await fs.readFile(path.join(ba, "package-lock.json"), "utf8");
    expect(sharedLock).toContain("@acme/base");
    expect(sharedLock).not.toContain("@acme/reader");
    expect(baLock).toContain("@acme/reader");
    expect(baLock).not.toContain("@acme/base");
  });

  test("another audience is neither installed nor written", async () => {
    const dir = await companion();

    await install(dir, "ba");

    expect(await exists(dynamicPluginsWorkspaceRoot(dir, "qa"))).toBe(false);
  });

  test("a run without the audience leaves its manifest and lockfile byte-identical", async () => {
    const dir = await companion();
    await install(dir, "ba");
    const ba = dynamicPluginsWorkspaceRoot(dir, "ba");
    const before = await Promise.all(
      ["package.json", "package-lock.json"].map((file) => fs.readFile(path.join(ba, file), "utf8")),
    );
    const edited = {
      ...CONFIG,
      audiences: { ...CONFIG.audiences, ba: { plugins: [{ ...READER, version: "^2.0.0" }] } },
    };

    await install(dir, null, fakeNpm(), edited);
    await install(dir, "qa", fakeNpm(), edited);

    const after = await Promise.all(
      ["package.json", "package-lock.json"].map((file) => fs.readFile(path.join(ba, file), "utf8")),
    );
    expect(after).toEqual(before);

    await install(dir, "ba", fakeNpm(), edited);
    expect(await readDependencies(ba)).toEqual({ "@acme/reader": "^2.0.0" });
  });

  test("dropping the audience removes its tree, keeps its files and names the way back", async () => {
    const dir = await companion();
    await install(dir, "ba");

    const outcome = await install(dir, null);

    const ba = dynamicPluginsWorkspaceRoot(dir, "ba");
    expect(outcome.removed).toEqual(["ba"]);
    expect(describeRemovedAudience("ba")).toContain('"ba"');
    expect(describeRemovedAudience("ba")).toContain("MATE_AUDIENCE=ba mate install");
    expect(await exists(path.join(ba, "node_modules"))).toBe(false);
    expect(await exists(path.join(ba, "package.json"))).toBe(true);
    expect(await exists(path.join(ba, "package-lock.json"))).toBe(true);
  });

  test("switching the audience removes the previous one's tree", async () => {
    const dir = await companion();
    await install(dir, "ba");

    const outcome = await install(dir, "qa");

    expect(outcome.removed).toEqual(["ba"]);
    expect(await exists(pluginPackageRoot(dir, "@acme/reader", "ba"))).toBe(false);
    expect(await exists(pluginPackageRoot(dir, "@acme/tester", "qa"))).toBe(true);
  });

  test("nothing to remove names no audience, and a frozen restore removes too", async () => {
    const dir = await companion();
    expect((await install(dir, null)).removed).toEqual([]);
    await install(dir, "ba");
    expect((await install(dir, "ba")).removed).toEqual([]);

    expect((await restore(dir, null)).removed).toEqual(["ba"]);
  });

  test("an empty base list prunes a stale shared workspace", async () => {
    const dir = await companion();
    await install(dir, null);
    const npm = fakeNpm();

    const outcome = await install(dir, null, npm, { plugins: [] });

    expect(outcome.results).toEqual([]);
    expect(outcome.declared).toBe(false);
    expect(await readDependencies(dynamicPluginsWorkspaceRoot(dir))).toEqual({});
    expect(await exists(pluginPackageRoot(dir, "@acme/base"))).toBe(false);
  });

  test("no declaration and no manifest writes nothing", async () => {
    const dir = await companion({ plugins: [] });
    const npm = fakeNpm();

    await install(dir, null, npm, { plugins: [] });

    expect(npm.calls).toEqual([]);
    expect(await exists(dynamicPluginsWorkspaceRoot(dir))).toBe(false);
  });
});

describe("removeUnselectedAudienceTrees", () => {
  test("removes the tree of an audience the companion no longer declares", async () => {
    const dir = await companion();
    const gone = path.join(dynamicPluginsWorkspaceRoot(dir, "legacy"), "node_modules");
    const kept = path.join(dynamicPluginsWorkspaceRoot(dir, "ba"), "node_modules");
    await fs.mkdir(gone, { recursive: true });
    await fs.mkdir(kept, { recursive: true });

    expect(await removeUnselectedAudienceTrees(dir, "ba")).toEqual(["legacy"]);
    expect(await exists(gone)).toBe(false);
    expect(await exists(kept)).toBe(true);
  });

  test("is a no-op without audience workspaces", async () => {
    expect(await removeUnselectedAudienceTrees(await companion(), null)).toEqual([]);
  });
});

describe("the shared registry file", () => {
  const REGISTRY = "@acme:registry=https://registry.acme.test/\n";

  test("applies to the audience workspace's npm run through a relative link", async () => {
    const dir = await companion();
    await fs.mkdir(dynamicPluginsWorkspaceRoot(dir), { recursive: true });
    await fs.writeFile(path.join(dynamicPluginsWorkspaceRoot(dir), ".npmrc"), REGISTRY);
    const npm = fakeNpm();

    await install(dir, "ba", npm);

    expect(npm.npmrc).toEqual([REGISTRY, REGISTRY]);
    const link = path.join(dynamicPluginsWorkspaceRoot(dir, "ba"), ".npmrc");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(link)).toBe(path.join("..", "..", ".npmrc"));
  });

  test("creates nothing without a shared file and keeps a file placed in the workspace", async () => {
    const dir = await companion();
    const ba = dynamicPluginsWorkspaceRoot(dir, "ba");
    await linkSharedNpmrc(dir, "ba");
    expect(await exists(ba)).toBe(false);

    await fs.mkdir(ba, { recursive: true });
    await fs.writeFile(path.join(ba, ".npmrc"), "own\n");
    await fs.writeFile(path.join(dynamicPluginsWorkspaceRoot(dir), ".npmrc"), REGISTRY);
    await linkSharedNpmrc(dir, "ba");
    expect(await fs.readFile(path.join(ba, ".npmrc"), "utf8")).toBe("own\n");
  });

  test("drops a dangling link and links again once the shared file is back", async () => {
    const dir = await companion();
    const shared = path.join(dynamicPluginsWorkspaceRoot(dir), ".npmrc");
    const link = path.join(dynamicPluginsWorkspaceRoot(dir, "ba"), ".npmrc");
    await fs.mkdir(dynamicPluginsWorkspaceRoot(dir), { recursive: true });
    await fs.writeFile(shared, REGISTRY);
    await linkSharedNpmrc(dir, "ba");
    await fs.rm(shared);

    await linkSharedNpmrc(dir, "ba");
    expect(await fs.lstat(link).catch(() => null)).toBeNull();

    await fs.writeFile(shared, REGISTRY);
    await linkSharedNpmrc(dir, "ba");
    expect(await fs.readFile(link, "utf8")).toBe(REGISTRY);
  });
});

describe("frozen restore per workspace", () => {
  test("restores the base and the selected audience from their own locks without changing a tracked file", async () => {
    const dir = await companion();
    await install(dir, "ba");
    await fs.rm(path.join(dynamicPluginsWorkspaceRoot(dir), "node_modules"), { recursive: true });
    await fs.rm(path.join(dynamicPluginsWorkspaceRoot(dir, "ba"), "node_modules"), {
      recursive: true,
    });
    const before = await trackedFiles(dir);

    const outcome = await restore(dir, "ba");

    expect(outcome.results.map((result) => [result.package, result.status])).toEqual([
      ["@acme/base", "installed"],
      ["@acme/reader", "installed"],
    ]);
    expect(await trackedFiles(dir)).toEqual(before);
  });

  test("a missing audience manifest or lockfile names the file and the relocking install", async () => {
    const dir = await companion();
    await install(dir, null);

    const missingManifest = await restore(dir, "ba").catch((error: unknown) => error);
    expect(missingManifest).toBeInstanceOf(FrozenInstallError);
    expect((missingManifest as Error).message).toContain(
      path.join(dynamicPluginsWorkspaceRoot(dir, "ba"), "package.json"),
    );
    expect((missingManifest as Error).message).toContain("MATE_AUDIENCE=ba mate install");

    await install(dir, "ba");
    const lockFile = path.join(dynamicPluginsWorkspaceRoot(dir, "ba"), "package-lock.json");
    await fs.rm(lockFile);
    const missingLock = await restore(dir, "ba").catch((error: unknown) => error);
    expect((missingLock as Error).message).toContain(lockFile);
    expect((missingLock as Error).message).toContain("MATE_AUDIENCE=ba mate install");
  });

  test("another audience's broken lock is not read", async () => {
    const dir = await companion();
    await install(dir, "qa");
    await install(dir, "ba");
    await fs.writeFile(
      path.join(dynamicPluginsWorkspaceRoot(dir, "qa"), "package-lock.json"),
      "{ broken",
    );

    const outcome = await restore(dir, "ba");

    expect(outcome.results.every((result) => result.status !== "failed")).toBe(true);
  });

  test("without an audience only the shared workspace is restored", async () => {
    const dir = await companion();
    await install(dir, null);

    const outcome = await restore(dir, null);

    expect(outcome.results.map((result) => result.package)).toEqual(["@acme/base"]);
    expect(await exists(path.join(dir, ".mate", "plugins", "audiences"))).toBe(false);
  });

  test("a companion without plugins or a plugin workspace restores nothing", async () => {
    const dir = await companion({ plugins: [] });

    expect((await restore(dir, null, { plugins: [] })).results).toEqual([]);
    expect(await exists(dynamicPluginsWorkspaceRoot(dir))).toBe(false);
  });
});

describe("migration out of the union workspace", () => {
  /** The shared workspace as a Mate before audience workspaces left it: base plus every audience. */
  async function unionCompanion(config: unknown = CONFIG): Promise<string> {
    const dir = await companion(config);
    const union = { plugins: [BASE, READER, TESTER] };
    await install(dir, null, fakeNpm(), union);
    return dir;
  }

  const engines = async (dir: string) =>
    (
      parse(await fs.readFile(path.join(dir, ".mate", "config", "framework.yaml"), "utf8")) as {
        engines?: Record<string, string>;
      }
    ).engines;

  test("an ordinary install rewrites the shared workspace to base only and raises the floor", async () => {
    const dir = await unionCompanion();

    const outcome = await install(dir, null);

    expect(outcome.migrated).toBe(true);
    const shared = dynamicPluginsWorkspaceRoot(dir);
    expect(await readDependencies(shared)).toEqual({ "@acme/base": "^1.0.0" });
    expect(await fs.readFile(path.join(shared, "package-lock.json"), "utf8")).not.toContain(
      "@acme/reader",
    );
    expect(await exists(pluginPackageRoot(dir, "@acme/reader"))).toBe(false);
    expect(await engines(dir)).toEqual({ mate: `>=${AUDIENCE_WORKSPACES_VERSION}` });
  });

  test("the migration adds no defaults and keeps the other engines", async () => {
    const dir = await unionCompanion({ ...CONFIG, engines: { mate: ">=0.15.0", acme: ">=1.0.0" } });

    await install(dir, null);

    const saved = parse(
      await fs.readFile(path.join(dir, ".mate", "config", "framework.yaml"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(saved).toSorted()).toEqual(["audiences", "engines", "plugins"]);
    expect(saved.engines).toEqual({ mate: `>=${AUDIENCE_WORKSPACES_VERSION}`, acme: ">=1.0.0" });
  });

  test("a floor already at or above the introducing version is kept", async () => {
    const dir = await unionCompanion({ ...CONFIG, engines: { mate: ">=99.0.0" } });

    const outcome = await install(dir, null);

    expect(outcome.migrated).toBe(false);
    expect(await engines(dir)).toEqual({ mate: ">=99.0.0" });
  });

  test("a migrated companion is not rewritten again", async () => {
    const dir = await unionCompanion();
    await install(dir, null);
    const before = await trackedFiles(dir);
    const npm = fakeNpm();

    const outcome = await install(dir, null, npm);

    expect(outcome.migrated).toBe(false);
    expect(npm.calls).toEqual([]);
    expect(await trackedFiles(dir)).toEqual(before);
  });

  test("a frozen restore refuses an unmigrated companion without changing a tracked file", async () => {
    const dir = await unionCompanion();
    const before = await trackedFiles(dir);

    const refusal = await restore(dir, null).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(FrozenInstallError);
    expect((refusal as Error).message).toContain("@acme/reader");
    expect((refusal as Error).message).toContain("`mate install`");
    expect(await trackedFiles(dir)).toEqual(before);
  });
});
