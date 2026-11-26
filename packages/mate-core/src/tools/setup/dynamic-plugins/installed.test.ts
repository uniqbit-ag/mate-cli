import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { installedPluginPackages } from "./installed";
import {
  audienceOrigin,
  BASE_PLUGIN_ORIGIN,
  LOCAL_PLUGIN_ORIGIN,
  localPluginsFilePath,
  pluginPackageRoot,
  type PluginOrigin,
} from "./paths";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function companion(framework: unknown, localYaml?: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installed-plugins-"));
  roots.push(dir);
  await fs.mkdir(path.join(dir, ".mate", "config"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".mate", "config", "framework.yaml"),
    JSON.stringify(framework),
  );
  if (localYaml !== undefined) await fs.writeFile(localPluginsFilePath(dir), localYaml);
  return dir;
}

async function install(
  dir: string,
  name: string,
  version: string,
  origin: PluginOrigin = BASE_PLUGIN_ORIGIN,
): Promise<string> {
  const root = pluginPackageRoot(dir, name, origin);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name, version }));
  // Never imported: a listing that ran plugin code would throw here.
  await fs.writeFile(path.join(root, "index.js"), "throw new Error('imported');\n");
  return root;
}

describe("installedPluginPackages", () => {
  test("lists installed plugins in hydration order with version and root", async () => {
    const dir = await companion(
      {
        plugins: [
          { package: "mate-plugin-acme", version: "^1.0.0" },
          { package: "@acme/missing", version: "1.0.0" },
        ],
        audiences: { ba: { plugins: [{ package: "@acme/reader", version: "2.0.0" }] } },
      },
      'plugins:\n  - package: "@acme/local"\n    version: "file:./acme.tgz"\n',
    );
    const acme = await install(dir, "mate-plugin-acme", "1.2.0");
    const reader = await install(dir, "@acme/reader", "2.0.0", audienceOrigin("ba"));
    const local = await install(dir, "@acme/local", "0.1.0", LOCAL_PLUGIN_ORIGIN);

    expect(await installedPluginPackages(dir, { audience: "ba" })).toEqual([
      { package: "mate-plugin-acme", version: "1.2.0", root: acme, origin: BASE_PLUGIN_ORIGIN },
      { package: "@acme/reader", version: "2.0.0", root: reader, origin: audienceOrigin("ba") },
      { package: "@acme/local", version: "0.1.0", root: local, origin: LOCAL_PLUGIN_ORIGIN },
    ]);
  });

  test("lists the base plugins only without the audience, and no local ones when asked", async () => {
    const dir = await companion(
      {
        plugins: [{ package: "mate-plugin-acme", version: "1.0.0" }],
        audiences: { ba: { plugins: [{ package: "@acme/reader", version: "2.0.0" }] } },
      },
      'plugins:\n  - package: "@acme/local"\n    version: "file:./acme.tgz"\n',
    );
    await install(dir, "mate-plugin-acme", "1.0.0");
    await install(dir, "@acme/reader", "2.0.0", audienceOrigin("ba"));
    await install(dir, "@acme/local", "0.1.0", LOCAL_PLUGIN_ORIGIN);

    const names = (await installedPluginPackages(dir, { includeLocal: false })).map(
      (entry) => entry.package,
    );
    expect(names).toEqual(["mate-plugin-acme"]);
  });

  test("a companion without framework.yaml lists none", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installed-plugins-"));
    roots.push(dir);
    expect(await installedPluginPackages(dir)).toEqual([]);
  });
});
