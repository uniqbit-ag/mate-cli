import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { CapabilityContributionInput } from "../plugin";
import { gatherClaudePluginDirectories } from "./claude";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugin-dirs-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A folder Claude would load as a plugin. */
async function pluginFolder(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
  await fs.writeFile(path.join(dir, ".claude-plugin", "plugin.json"), `{"name":"${name}"}\n`);
  return dir;
}

function declaring(pluginId: string, enabled: boolean, ...paths: string[]) {
  return {
    pluginId,
    enabled,
    contributions: { pluginDirectories: paths.map((dirPath) => ({ path: dirPath })) },
  } satisfies CapabilityContributionInput;
}

describe("gatherClaudePluginDirectories", () => {
  test("returns an enabled Capability's folder", async () => {
    const root = await makeRoot();
    const folder = await pluginFolder(root, "acme");

    expect(await gatherClaudePluginDirectories([declaring("acme", true, folder)])).toEqual({
      directories: [folder],
      warnings: [],
    });
  });

  test("does not return a disabled Capability's folder", async () => {
    const root = await makeRoot();
    const folder = await pluginFolder(root, "acme");

    expect(await gatherClaudePluginDirectories([declaring("acme", false, folder)])).toEqual({
      directories: [],
      warnings: [],
    });
  });

  test("keeps Capability registration order", async () => {
    const root = await makeRoot();
    const first = await pluginFolder(root, "zeta");
    const second = await pluginFolder(root, "alpha");

    const gathered = await gatherClaudePluginDirectories([
      declaring("zeta", true, first),
      declaring("alpha", true, second),
    ]);

    expect(gathered.directories).toEqual([first, second]);
  });

  test("leaves out a folder that holds no plugin manifest, with a warning", async () => {
    const root = await makeRoot();
    const empty = path.join(root, "empty");
    await fs.mkdir(empty);
    const missing = path.join(root, "missing");

    const gathered = await gatherClaudePluginDirectories([declaring("acme", true, empty, missing)]);

    expect(gathered.directories).toEqual([]);
    expect(gathered.warnings).toHaveLength(2);
    expect(gathered.warnings[0]).toContain("acme");
    expect(gathered.warnings[0]).toContain(empty);
    expect(gathered.warnings[1]).toContain("acme");
    expect(gathered.warnings[1]).toContain(missing);
  });

  test("leaves out a relative path, with a warning", async () => {
    const gathered = await gatherClaudePluginDirectories([declaring("acme", true, "plugins/acme")]);

    expect(gathered.directories).toEqual([]);
    expect(gathered.warnings).toHaveLength(1);
    expect(gathered.warnings[0]).toContain("acme");
    expect(gathered.warnings[0]).toContain("plugins/acme");
  });

  test("returns a folder declared twice once, at its first declaration", async () => {
    const root = await makeRoot();
    const shared = await pluginFolder(root, "shared");
    const own = await pluginFolder(root, "own");

    const gathered = await gatherClaudePluginDirectories([
      declaring("acme", true, shared),
      declaring("beta", true, own, shared),
    ]);

    expect(gathered).toEqual({ directories: [shared, own], warnings: [] });
  });

  test("returns a folder spelled with a trailing separator once, without the separator", async () => {
    const root = await makeRoot();
    const folder = await pluginFolder(root, "acme");

    const gathered = await gatherClaudePluginDirectories([
      declaring("acme", true, `${folder}${path.sep}`),
      declaring("beta", true, folder),
    ]);

    expect(gathered).toEqual({ directories: [folder], warnings: [] });
  });

  test("returns a folder reached through a symlink once, at its first declaration", async () => {
    const root = await makeRoot();
    const folder = await pluginFolder(root, "acme");
    const alias = path.join(root, "acme-link");
    await fs.symlink(folder, alias);

    const gathered = await gatherClaudePluginDirectories([
      declaring("acme", true, alias),
      declaring("beta", true, folder),
    ]);

    expect(gathered).toEqual({ directories: [alias], warnings: [] });
  });

  test("warns once for a missing folder declared twice", async () => {
    const root = await makeRoot();
    const missing = path.join(root, "missing");

    const gathered = await gatherClaudePluginDirectories([
      declaring("acme", true, missing),
      declaring("beta", true, `${missing}${path.sep}`),
    ]);

    expect(gathered.directories).toEqual([]);
    expect(gathered.warnings).toHaveLength(1);
  });

  test("returns a path that contains a space unchanged", async () => {
    const root = await makeRoot();
    const folder = await pluginFolder(root, "My Plugins");

    expect(await gatherClaudePluginDirectories([declaring("acme", true, folder)])).toEqual({
      directories: [folder],
      warnings: [],
    });
  });

  test("a Capability without plugin folders contributes nothing", async () => {
    const gathered = await gatherClaudePluginDirectories([
      { pluginId: "acme", enabled: true, contributions: { permissionEntries: ["mcp__acme__*"] } },
    ]);

    expect(gathered).toEqual({ directories: [], warnings: [] });
  });
});
