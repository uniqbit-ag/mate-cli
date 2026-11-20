import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { git } from "../../../../test/git-checkouts";
import { fakePluginInstallDeps } from "../../../../test/plugin-install";
import { PluginRegistry } from "../registry";
import type { PluginHost } from "./host";
import { hydrateDynamicPlugins, resetDynamicPluginHydration } from "./hydrate";
import type { NpmInstallRunner } from "./install";
import { declareLocalPlugin, readLocalPlugins } from "./local";
import {
  audienceOrigin,
  dynamicPluginsWorkspaceRoot,
  LOCAL_PLUGIN_ORIGIN,
  localPluginsFilePath,
  pluginPackageRoot,
  type PluginOrigin,
} from "./paths";
import { inspectDeclaredPlugins, verifyDeclaredPlugins } from "./verify";
import { installPluginWorkspaces } from "./workspaces";

const LOCAL_FILE = ".mate/config/framework.local.yaml";
const GATED = "@acme/gated";
const BASE = { package: "@acme/base", version: "1.0.0" };
const READER = { package: "@acme/reader", version: "1.0.0" };
const FRAMEWORK = { plugins: [BASE], audiences: { ba: { plugins: [READER] } } };

const roots: string[] = [];

beforeEach(() => resetDynamicPluginHydration());
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const fakeHost: PluginHost = {
  apiVersion: 1,
  distribution: { name: "acme-mate", version: "0.0.1" },
  ensureCapabilityEnabled: async () => true,
};

const localEntry = (version = "1.0.0", name = GATED) =>
  `plugins:\n  - package: "${name}"\n    version: "${version}"\n`;

async function companion(localYaml?: string, framework: unknown = FRAMEWORK): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-plugins-"));
  roots.push(dir);
  await fs.mkdir(path.join(dir, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".mate", "config", "framework.yaml"),
    JSON.stringify(framework),
  );
  if (localYaml !== undefined) await fs.writeFile(localPluginsFilePath(dir), localYaml);
  return dir;
}

async function forceTrack(dir: string, relativePath: string): Promise<void> {
  git(dir, "init", "-q");
  await fs.mkdir(path.dirname(path.join(dir, relativePath)), { recursive: true });
  await fs.writeFile(path.join(dir, relativePath), "plugins: []\n", { flag: "a" });
  git(dir, "add", "-f", relativePath);
}

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

/** Simulates `npm install`; a `file:` dependency records the tarball's digest and content. */
function fakeNpm(): { runner: NpmInstallRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: async (workspaceRoot) => {
      calls.push(workspaceRoot);
      const { dependencies } = JSON.parse(
        await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      await fs.rm(path.join(workspaceRoot, "node_modules"), { recursive: true, force: true });
      const packages: Record<string, unknown> = {};
      for (const [name, version] of Object.entries(dependencies)) {
        const root = path.join(workspaceRoot, "node_modules", ...name.split("/"));
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name, version: "1" }));
        const entry: Record<string, string> = { version: "1" };
        if (version.startsWith("file:")) {
          const content = await fs.readFile(version.slice("file:".length));
          await fs.writeFile(path.join(root, "content.txt"), content);
          entry.integrity = `sha512-${createHash("sha512").update(content).digest("base64")}`;
        }
        packages[`node_modules/${name}`] = entry;
      }
      await fs.writeFile(
        path.join(workspaceRoot, "package-lock.json"),
        JSON.stringify({ lockfileVersion: 3, packages }),
      );
      return { ok: true };
    },
  };
}

function install(dir: string, npm: { runner: NpmInstallRunner }, framework: unknown = FRAMEWORK) {
  return installPluginWorkspaces(dir, framework, null, {
    installDeps: fakePluginInstallDeps({ runNpmInstall: npm.runner }),
  });
}

const localWorkspace = (dir: string) => dynamicPluginsWorkspaceRoot(dir, LOCAL_PLUGIN_ORIGIN);
const failures = (outcome: Awaited<ReturnType<typeof install>>) =>
  outcome.results.filter((result) => result.status === "failed");

describe("readLocalPlugins", () => {
  test("returns the declared entries", async () => {
    const dir = await companion(localEntry());
    expect(await readLocalPlugins(dir, FRAMEWORK)).toEqual({
      present: true,
      declarations: [{ package: GATED, version: "1.0.0" }],
      problems: [],
    });
  });

  test("an unknown key refuses the file, naming it and the key", async () => {
    const dir = await companion(`${localEntry()}capabilities: []\n`);
    const read = await readLocalPlugins(dir, FRAMEWORK);
    expect(read.declarations).toEqual([]);
    expect(read.problems[0]?.message).toContain(LOCAL_FILE);
    expect(read.problems[0]?.message).toContain("capabilities");
  });

  test("one invalid entry refuses every entry", async () => {
    const dir = await companion(`${localEntry()}  - package: "@acme/no-version"\n`);
    const read = await readLocalPlugins(dir, FRAMEWORK);
    expect(read.declarations).toEqual([]);
    expect(read.problems[0]?.message).toContain(LOCAL_FILE);
  });

  test("a package listed twice is refused", async () => {
    const dir = await companion(`${localEntry()}  - package: "${GATED}"\n    version: "2.0.0"\n`);
    const read = await readLocalPlugins(dir, FRAMEWORK);
    expect(read.declarations).toEqual([]);
    expect(read.problems[0]?.message).toContain("more than once");
  });

  test("an unparsable file names the file", async () => {
    const read = await readLocalPlugins(await companion("plugins: [\n"), FRAMEWORK);
    expect(read.declarations).toEqual([]);
    expect(read.problems[0]?.message).toContain(LOCAL_FILE);
  });

  test("a tracked file is refused with the way out", async () => {
    const dir = await companion(localEntry());
    await forceTrack(dir, LOCAL_FILE);
    const read = await readLocalPlugins(dir, FRAMEWORK);
    expect(read.declarations).toEqual([]);
    expect(read.problems[0]?.message).toContain(LOCAL_FILE);
    expect(read.problems[0]?.message).toContain("git rm --cached");
  });

  test("a conflict drops only the entry that conflicts", async () => {
    const yaml = [localEntry(), `  - package: "${BASE.package}"\n    version: "2.0.0"\n`].join("");
    const withAudience = `${yaml}  - package: "${READER.package}"\n    version: "2.0.0"\n`;
    const read = await readLocalPlugins(await companion(withAudience), FRAMEWORK);
    expect(read.declarations.map((entry) => entry.package)).toEqual([GATED]);
    expect(read.problems.map((problem) => problem.package)).toEqual([BASE.package, READER.package]);
  });

  test("a hub has no local plugins", async () => {
    const hub = { type: "hub" };
    const read = await readLocalPlugins(await companion("not: [valid\n", hub), hub);
    expect(read).toEqual({ present: false, declarations: [], problems: [] });
  });
});

describe("declareLocalPlugin", () => {
  test("adds an entry and updates a version, keeping comments", async () => {
    const dir = await companion(`# my gated tools\n${localEntry()}`);
    expect(await declareLocalPlugin(dir, FRAMEWORK, "@acme/other", "3.0.0")).toEqual([]);
    expect(await declareLocalPlugin(dir, FRAMEWORK, GATED, "2.0.0")).toEqual([]);

    const text = await fs.readFile(localPluginsFilePath(dir), "utf8");
    expect(text).toContain("# my gated tools");
    expect((await readLocalPlugins(dir, FRAMEWORK)).declarations).toEqual([
      { package: GATED, version: "2.0.0" },
      { package: "@acme/other", version: "3.0.0" },
    ]);
  });
});

describe("local install step", () => {
  test("installs into the local workspace and leaves tracked files alone", async () => {
    const dir = await companion(localEntry());
    const npm = fakeNpm();
    await install(dir, npm);
    const tracked = ["config/framework.yaml", "plugins/package.json", "plugins/package-lock.json"];
    const read = () =>
      Promise.all(tracked.map((file) => fs.readFile(path.join(dir, ".mate", file), "utf8")));
    const before = await read();
    await fs.rm(path.join(localWorkspace(dir), "node_modules"), { recursive: true });

    const outcome = await install(dir, npm);

    expect(outcome.declared).toBe(true);
    expect(await exists(pluginPackageRoot(dir, GATED, LOCAL_PLUGIN_ORIGIN))).toBe(true);
    expect(await read()).toEqual(before);
    expect(before.join("")).not.toContain(GATED);
  });

  test("adds the ignore entries inside the managed block, keeping other lines", async () => {
    const dir = await companion(localEntry());
    const gitignore = path.join(dir, ".gitignore");
    await fs.writeFile(
      gitignore,
      "mine\n\n# mate managed: start\nnode_modules/\n# mate managed: end\n\nlast\n",
    );

    await install(dir, fakeNpm());

    expect(await fs.readFile(gitignore, "utf8")).toBe(
      `mine\n\n# mate managed: start\nnode_modules/\n${LOCAL_FILE}\n.mate/local-plugins/\n.mate/config/plugins.local.yaml\n# mate managed: end\n\nlast\n`,
    );
  });

  test("prunes an entry removed from the file, and all of them when the file goes", async () => {
    const dir = await companion(`${localEntry()}  - package: "@acme/other"\n    version: "1"\n`);
    const npm = fakeNpm();
    await install(dir, npm);

    await fs.writeFile(localPluginsFilePath(dir), localEntry(`1.0.0`, "@acme/other"));
    await install(dir, npm);
    expect(await exists(pluginPackageRoot(dir, GATED, LOCAL_PLUGIN_ORIGIN))).toBe(false);

    await fs.rm(localPluginsFilePath(dir));
    await install(dir, npm);
    expect(await exists(pluginPackageRoot(dir, "@acme/other", LOCAL_PLUGIN_ORIGIN))).toBe(false);
  });

  test("an npm failure fails the package with npm's error", async () => {
    const dir = await companion(localEntry(), { plugins: [] });
    const outcome = await install(
      dir,
      { runner: async () => ({ ok: false, detail: "E404" }) },
      { plugins: [] },
    );
    expect(failures(outcome)).toEqual([{ package: GATED, status: "failed", error: "E404" }]);
  });

  for (const [name, yaml] of [
    ["an unknown key", `${localEntry()}capabilities: []\n`],
    ["a conflict", localEntry("2.0.0", BASE.package)],
  ] as const) {
    test(`${name} is refused before npm runs`, async () => {
      const dir = await companion(yaml);
      const npm = fakeNpm();
      const outcome = await install(dir, npm);
      expect(failures(outcome)).toHaveLength(1);
      expect(failures(outcome)[0]?.refused).toBe(true);
      expect(npm.calls).not.toContain(localWorkspace(dir));
    });
  }

  test("a tracked file below the workspace is refused before npm runs", async () => {
    const dir = await companion(localEntry());
    await forceTrack(dir, ".mate/local-plugins/node_modules/@acme/gated/index.js");
    const npm = fakeNpm();
    const outcome = await install(dir, npm);
    expect(failures(outcome)[0]?.error).toContain("git rm --cached");
    expect(npm.calls).not.toContain(localWorkspace(dir));
  });

  test("a tracked workspace file is refused without a local file or manifest", async () => {
    const dir = await companion();
    await forceTrack(dir, ".mate/local-plugins/node_modules/@acme/gated/index.js");
    const outcome = await install(dir, fakeNpm());
    expect(failures(outcome)[0]?.error).toContain("git rm --cached");
  });

  test("a rebuilt tarball is reinstalled and an unchanged one is not", async () => {
    const dir = await companion();
    const tarball = path.join(dir, "acme-gated.tgz");
    await fs.writeFile(tarball, "first");
    await fs.writeFile(localPluginsFilePath(dir), localEntry(`file:${tarball}`));
    const npm = fakeNpm();
    const content = path.join(pluginPackageRoot(dir, GATED, LOCAL_PLUGIN_ORIGIN), "content.txt");
    const localRuns = () => npm.calls.filter((call) => call === localWorkspace(dir)).length;

    await install(dir, npm);
    expect(localRuns()).toBe(1);
    await install(dir, npm);
    expect(localRuns()).toBe(1);

    await fs.writeFile(tarball, "second");
    await install(dir, npm);
    expect(localRuns()).toBe(2);
    expect(await fs.readFile(content, "utf8")).toBe("second");
  });

  test("a frozen restore ignores a broken local file", async () => {
    const dir = await companion("plugins: [\n", { plugins: [] });
    const outcome = await installPluginWorkspaces(dir, { plugins: [] }, null, {
      frozen: true,
      frozenDeps: { runNpmCi: async () => ({ ok: true }), env: {} },
    });
    expect(outcome.results).toEqual([]);
    expect(outcome.declared).toBe(false);
    expect(await exists(localWorkspace(dir))).toBe(false);
  });
});

function pluginSource(id: string, marker?: string): string {
  const side = marker
    ? `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`
    : "";
  return `${side}export default () => ({ id: "${id}", kind: "capability", label: "${id}",
  description: "fixture", defaultSelected: false, isEnabled: () => false,
  apply: async () => {}, teardown: async () => {},
  cliCommands: [{ name: "hello", description: "hello", run: async () => {} }] });`;
}

async function installFixture(
  dir: string,
  name: string,
  origin: PluginOrigin,
  source: string,
): Promise<void> {
  const root = pluginPackageRoot(dir, name, origin);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js" }),
  );
  await fs.writeFile(path.join(root, "index.js"), source);
}

async function hydrate(dir: string, env: Record<string, string> = {}, includeLocal?: boolean) {
  const registry = new PluginRegistry([]);
  const warnings: string[] = [];
  await hydrateDynamicPlugins({
    companionPath: dir,
    registry,
    host: fakeHost,
    env,
    includeLocal,
    warn: (message) => warnings.push(message),
  });
  return { ids: registry.getAll().map((plugin) => plugin.id), registry, warnings };
}

describe("local plugin hydration", () => {
  const COMMITTED = { plugins: [BASE] };

  test("a local plugin loads after committed ones with its cap command", async () => {
    const dir = await companion(localEntry(), COMMITTED);
    await installFixture(dir, BASE.package, audienceOrigin(null), pluginSource("acme-base"));
    await installFixture(dir, GATED, LOCAL_PLUGIN_ORIGIN, pluginSource("acme-gated"));

    const { ids, registry, warnings } = await hydrate(dir);

    expect(warnings).toEqual([]);
    expect(ids).toEqual(["acme-base", "acme-gated"]);
    expect(registry.getAll()[1]?.cliCommands?.map((command) => command.name)).toEqual(["hello"]);
    expect(registry.getAll()[1]?.selectable).toBe(false);
  });

  test("the audience does not matter", async () => {
    const dir = await companion(localEntry());
    await installFixture(dir, GATED, LOCAL_PLUGIN_ORIGIN, pluginSource("acme-gated"));
    expect((await hydrate(dir, { MATE_AUDIENCE: "ba" })).ids).toContain("acme-gated");
  });

  test("a missing install warns and committed plugins still load", async () => {
    const dir = await companion(localEntry(), COMMITTED);
    await installFixture(dir, BASE.package, audienceOrigin(null), pluginSource("acme-base"));

    const { ids, warnings } = await hydrate(dir);

    expect(ids).toEqual(["acme-base"]);
    expect(warnings.join("\n")).toContain(GATED);
    expect(warnings.join("\n")).toContain("mate install");
  });

  test("a conflict warns and keeps the committed plugin", async () => {
    const dir = await companion(localEntry("2.0.0", READER.package));
    const ba = audienceOrigin("ba");
    await installFixture(dir, READER.package, ba, pluginSource("acme-audience"));
    const marker = path.join(dir, "local-ran");
    await installFixture(
      dir,
      READER.package,
      LOCAL_PLUGIN_ORIGIN,
      pluginSource("acme-local", marker),
    );

    const { ids, warnings } = await hydrate(dir, { MATE_AUDIENCE: "ba" });

    expect(ids).toContain("acme-audience");
    expect(ids).not.toContain("acme-local");
    expect(await exists(marker)).toBe(false);
    expect(warnings.join("\n")).toContain(READER.package);
  });

  test("a local plugin cannot take a namespace a committed plugin holds", async () => {
    const dir = await companion(localEntry(), COMMITTED);
    await installFixture(dir, BASE.package, audienceOrigin(null), pluginSource("acme-shared"));
    await installFixture(dir, GATED, LOCAL_PLUGIN_ORIGIN, pluginSource("acme-shared"));

    const { ids, warnings } = await hydrate(dir);

    expect(ids).toEqual(["acme-shared"]);
    expect(warnings.join("\n")).toContain(GATED);
  });

  for (const [name, prepare] of [
    ["an invalid file", (dir: string) => fs.writeFile(localPluginsFilePath(dir), "plugins: [\n")],
    ["a tracked file", (dir: string) => forceTrack(dir, LOCAL_FILE)],
  ] as const) {
    test(`${name} imports nothing and warns with the file name`, async () => {
      const dir = await companion(localEntry(), COMMITTED);
      const marker = path.join(dir, "local-ran");
      await installFixture(dir, BASE.package, audienceOrigin(null), pluginSource("acme-base"));
      await installFixture(dir, GATED, LOCAL_PLUGIN_ORIGIN, pluginSource("acme-gated", marker));
      await prepare(dir);

      const { ids, warnings } = await hydrate(dir);

      expect(ids).toEqual(["acme-base"]);
      expect(await exists(marker)).toBe(false);
      expect(warnings.join("\n")).toContain(LOCAL_FILE);
    });
  }

  test("a frozen restore's hydration does not read the local file", async () => {
    const dir = await companion("plugins: [\n", COMMITTED);
    expect((await hydrate(dir, {}, false)).warnings.join("\n")).not.toContain(LOCAL_FILE);
  });
});

describe("local plugin inspection", () => {
  test("doctor's inspection reports a missing local plugin, strict verification does not", async () => {
    const dir = await companion(localEntry(), { plugins: [] });

    const inspection = await inspectDeclaredPlugins(dir, { env: {}, includeLocal: true });

    expect(inspection.failures.map((failure) => failure.package)).toEqual([GATED]);
    expect(inspection.failures[0]?.reason).toContain("mate install");
    expect(await verifyDeclaredPlugins(dir, { env: {} })).toEqual([]);
  });
});
