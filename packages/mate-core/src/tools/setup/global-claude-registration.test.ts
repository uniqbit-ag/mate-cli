import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  mateGlobalMarketplaceDir,
  mateGlobalPluginKey,
  registerMateClaudePluginGlobally,
} from "./global-claude-registration";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("registerMateClaudePluginGlobally", () => {
  test("creates the marketplace scaffold, symlink, and user-scope settings entries", async () => {
    const root = await makeTempDir("mate-global-reg-");
    const mateHome = path.join(root, ".mate");
    const settingsPath = path.join(root, ".claude", "settings.json");
    const pluginRoot = path.join(root, "pkg", "claude-plugin");
    await fs.mkdir(pluginRoot, { recursive: true });

    await registerMateClaudePluginGlobally({
      mateHomeDir: mateHome,
      claudeSettingsPath: settingsPath,
      pluginRoot,
    });

    const marketplaceDir = mateGlobalMarketplaceDir(mateHome);
    const marketplace = JSON.parse(
      await fs.readFile(path.join(marketplaceDir, ".claude-plugin", "marketplace.json"), "utf8"),
    );
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: "mate", source: "./plugins/mate" }),
    ]);

    const linkTarget = await fs.readlink(path.join(marketplaceDir, "plugins", "mate"));
    expect(
      path.resolve(path.dirname(path.join(marketplaceDir, "plugins", "mate")), linkTarget),
    ).toBe(path.resolve(pluginRoot));

    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(settings.extraKnownMarketplaces.mate).toEqual({
      source: { source: "directory", path: marketplaceDir },
    });
    expect(settings.enabledPlugins[mateGlobalPluginKey()]).toBe(true);
  });

  test("re-points a stale symlink after a package move and preserves user settings", async () => {
    const root = await makeTempDir("mate-global-reg-move-");
    const mateHome = path.join(root, ".mate");
    const settingsPath = path.join(root, ".claude", "settings.json");
    const oldPluginRoot = path.join(root, "pkg-old", "claude-plugin");
    const newPluginRoot = path.join(root, "pkg-new", "claude-plugin");
    await fs.mkdir(oldPluginRoot, { recursive: true });
    await fs.mkdir(newPluginRoot, { recursive: true });
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ model: "opus", enabledPlugins: { "user@market": true } }),
      "utf8",
    );

    await registerMateClaudePluginGlobally({
      mateHomeDir: mateHome,
      claudeSettingsPath: settingsPath,
      pluginRoot: oldPluginRoot,
    });
    await registerMateClaudePluginGlobally({
      mateHomeDir: mateHome,
      claudeSettingsPath: settingsPath,
      pluginRoot: newPluginRoot,
    });

    const marketplaceDir = mateGlobalMarketplaceDir(mateHome);
    const linkPath = path.join(marketplaceDir, "plugins", "mate");
    const linkTarget = await fs.readlink(linkPath);
    expect(path.resolve(path.dirname(linkPath), linkTarget)).toBe(path.resolve(newPluginRoot));

    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.enabledPlugins["user@market"]).toBe(true);
    expect(settings.enabledPlugins[mateGlobalPluginKey()]).toBe(true);
  });

  test("double registration is byte-idempotent", async () => {
    const root = await makeTempDir("mate-global-reg-idem-");
    const mateHome = path.join(root, ".mate");
    const settingsPath = path.join(root, ".claude", "settings.json");
    const pluginRoot = path.join(root, "pkg", "claude-plugin");
    await fs.mkdir(pluginRoot, { recursive: true });

    const deps = { mateHomeDir: mateHome, claudeSettingsPath: settingsPath, pluginRoot };
    await registerMateClaudePluginGlobally(deps);
    const first = await fs.readFile(settingsPath, "utf8");
    await registerMateClaudePluginGlobally(deps);
    const second = await fs.readFile(settingsPath, "utf8");

    expect(second).toBe(first);
  });
});
