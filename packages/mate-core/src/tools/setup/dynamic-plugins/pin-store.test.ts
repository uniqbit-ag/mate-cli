import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { PluginPinStore } from "./pin-store";
import { pluginInstallDir, pluginPackageRoot, sanitizePluginDirName } from "./paths";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("PluginPinStore", () => {
  test("returns empty pins without creating the file when missing", async () => {
    const companionPath = await makeTempDir("plugin-pins-missing-");
    const store = new PluginPinStore(companionPath);

    const pins = await store.load();

    expect(pins.plugins).toEqual([]);
    expect(fs.access(store.configPath)).rejects.toThrow();
  });

  test("round-trips pins through .mate/config/plugins.lock.yaml", async () => {
    const companionPath = await makeTempDir("plugin-pins-roundtrip-");
    const store = new PluginPinStore(companionPath);

    await store.save({
      plugins: [
        {
          package: "@acme/custom-plugin",
          declaredVersion: "^1.0.0",
          resolvedVersion: "1.2.0",
          integrity: "sha512-abc",
        },
      ],
    });

    expect(store.configPath).toBe(path.join(companionPath, ".mate", "config", "plugins.lock.yaml"));
    const reloaded = await store.load();
    expect(reloaded.plugins).toEqual([
      {
        package: "@acme/custom-plugin",
        declaredVersion: "^1.0.0",
        resolvedVersion: "1.2.0",
        integrity: "sha512-abc",
      },
    ]);
  });

  test("tolerates a pin file without a plugins list", async () => {
    const companionPath = await makeTempDir("plugin-pins-empty-");
    const store = new PluginPinStore(companionPath);
    await fs.mkdir(path.dirname(store.configPath), { recursive: true });
    await fs.writeFile(store.configPath, "# empty\n", "utf8");

    const pins = await store.load();
    expect(pins.plugins).toEqual([]);
  });
});

describe("plugin paths", () => {
  test("sanitizes scoped package names into flat directory names", () => {
    expect(sanitizePluginDirName("@acme/custom-plugin")).toBe("acme-custom-plugin");
    expect(sanitizePluginDirName("plain-plugin")).toBe("plain-plugin");
  });

  test("install dir and package root live under .mate/dependencies/plugins", () => {
    expect(pluginInstallDir("/companion", "@acme/custom-plugin")).toBe(
      "/companion/.mate/dependencies/plugins/acme-custom-plugin",
    );
    expect(pluginPackageRoot("/companion", "@acme/custom-plugin")).toBe(
      "/companion/.mate/dependencies/plugins/acme-custom-plugin/node_modules/@acme/custom-plugin",
    );
  });
});
