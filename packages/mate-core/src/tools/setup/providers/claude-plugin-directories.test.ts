import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { MATE_CLAUDE_PLUGIN_NAME } from "../../../lib/package-paths";
import type { CapabilityContributionInput } from "../plugin";
import { describeClaudePluginDirectories, gatherClaudePluginDirectories } from "./claude";

const tempRoots: string[] = [];

/** Mate's bundled plugin for tests that declare no folder resolving to it. */
const BUNDLED_ELSEWHERE = path.join(os.tmpdir(), "mate-bundled-claude-plugin-elsewhere");

async function makeRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugin-dirs-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A folder holding `manifest` as its Claude plugin manifest. */
async function folderWithManifest(root: string, name: string, manifest: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
  await fs.writeFile(path.join(dir, ".claude-plugin", "plugin.json"), manifest);
  return dir;
}

/** A folder Claude would load as a plugin. */
async function pluginFolder(root: string, name: string): Promise<string> {
  return folderWithManifest(root, name, `{"name":"${name}"}\n`);
}

/** A folder whose manifest claims Mate's plugin name. */
async function mateNamedFolder(root: string, name: string): Promise<string> {
  return folderWithManifest(root, name, `{"name":"${MATE_CLAUDE_PLUGIN_NAME}"}\n`);
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

    expect(
      await gatherClaudePluginDirectories([declaring("acme", true, folder)], BUNDLED_ELSEWHERE),
    ).toEqual({ directories: [folder], warnings: [] });
  });

  test("does not return a disabled Capability's folder", async () => {
    const root = await makeRoot();
    const folder = await pluginFolder(root, "acme");

    expect(
      await gatherClaudePluginDirectories([declaring("acme", false, folder)], BUNDLED_ELSEWHERE),
    ).toEqual({ directories: [], warnings: [] });
  });

  test("keeps Capability registration order", async () => {
    const root = await makeRoot();
    const first = await pluginFolder(root, "zeta");
    const second = await pluginFolder(root, "alpha");

    const gathered = await gatherClaudePluginDirectories(
      [declaring("zeta", true, first), declaring("alpha", true, second)],
      BUNDLED_ELSEWHERE,
    );

    expect(gathered.directories).toEqual([first, second]);
  });

  test("leaves out a folder that holds no plugin manifest, with a warning", async () => {
    const root = await makeRoot();
    const empty = path.join(root, "empty");
    await fs.mkdir(empty);
    const missing = path.join(root, "missing");

    const gathered = await gatherClaudePluginDirectories(
      [declaring("acme", true, empty, missing)],
      BUNDLED_ELSEWHERE,
    );

    expect(gathered.directories).toEqual([]);
    expect(gathered.warnings).toHaveLength(2);
    expect(gathered.warnings[0]).toContain("acme");
    expect(gathered.warnings[0]).toContain(empty);
    expect(gathered.warnings[1]).toContain("acme");
    expect(gathered.warnings[1]).toContain(missing);
  });

  test("leaves out a relative path, with a warning", async () => {
    const gathered = await gatherClaudePluginDirectories(
      [declaring("acme", true, "plugins/acme")],
      BUNDLED_ELSEWHERE,
    );

    expect(gathered.directories).toEqual([]);
    expect(gathered.warnings).toHaveLength(1);
    expect(gathered.warnings[0]).toContain("acme");
    expect(gathered.warnings[0]).toContain("plugins/acme");
  });

  test("returns a folder declared twice once, at its first declaration", async () => {
    const root = await makeRoot();
    const shared = await pluginFolder(root, "shared");
    const own = await pluginFolder(root, "own");

    const gathered = await gatherClaudePluginDirectories(
      [declaring("acme", true, shared), declaring("beta", true, own, shared)],
      BUNDLED_ELSEWHERE,
    );

    expect(gathered).toEqual({ directories: [shared, own], warnings: [] });
  });

  test("returns a folder spelled with a trailing separator once, without the separator", async () => {
    const root = await makeRoot();
    const folder = await pluginFolder(root, "acme");

    const gathered = await gatherClaudePluginDirectories(
      [declaring("acme", true, `${folder}${path.sep}`), declaring("beta", true, folder)],
      BUNDLED_ELSEWHERE,
    );

    expect(gathered).toEqual({ directories: [folder], warnings: [] });
  });

  test("returns a folder reached through a symlink once, at its first declaration", async () => {
    const root = await makeRoot();
    const folder = await pluginFolder(root, "acme");
    const alias = path.join(root, "acme-link");
    await fs.symlink(folder, alias);

    const gathered = await gatherClaudePluginDirectories(
      [declaring("acme", true, alias), declaring("beta", true, folder)],
      BUNDLED_ELSEWHERE,
    );

    expect(gathered).toEqual({ directories: [alias], warnings: [] });
  });

  test("warns once for a missing folder declared twice", async () => {
    const root = await makeRoot();
    const missing = path.join(root, "missing");

    const gathered = await gatherClaudePluginDirectories(
      [declaring("acme", true, missing), declaring("beta", true, `${missing}${path.sep}`)],
      BUNDLED_ELSEWHERE,
    );

    expect(gathered.directories).toEqual([]);
    expect(gathered.warnings).toHaveLength(1);
  });

  test("returns a path that contains a space unchanged", async () => {
    const root = await makeRoot();
    const folder = await pluginFolder(root, "My Plugins");

    expect(
      await gatherClaudePluginDirectories([declaring("acme", true, folder)], BUNDLED_ELSEWHERE),
    ).toEqual({ directories: [folder], warnings: [] });
  });

  test("a Capability without plugin folders contributes nothing", async () => {
    const gathered = await gatherClaudePluginDirectories(
      [{ pluginId: "acme", enabled: true, contributions: { permissionEntries: ["mcp__acme__*"] } }],
      BUNDLED_ELSEWHERE,
    );

    expect(gathered).toEqual({ directories: [], warnings: [] });
  });

  describe("Mate's own plugin", () => {
    /** Mate's bundled plugin, as the launch passes it before every gathered folder. */
    async function bundledPlugin(): Promise<string> {
      return pluginFolder(await makeRoot(), MATE_CLAUDE_PLUGIN_NAME);
    }

    async function expectBundledPluginLeftOut(bundled: string, declared: string): Promise<void> {
      const gathered = await gatherClaudePluginDirectories(
        [declaring("acme", true, declared)],
        bundled,
      );

      expect(gathered.directories).toEqual([]);
      expect(gathered.warnings).toHaveLength(1);
      expect(gathered.warnings[0]).toContain("acme");
      expect(gathered.warnings[0]).toContain(declared);
      expect(gathered.warnings[0]).toContain("Mate's bundled plugin");
    }

    test("leaves out Mate's bundled plugin, with a warning", async () => {
      const bundled = await bundledPlugin();

      await expectBundledPluginLeftOut(bundled, bundled);
    });

    test("leaves out Mate's bundled plugin spelled with a trailing separator", async () => {
      const bundled = await bundledPlugin();

      await expectBundledPluginLeftOut(bundled, `${bundled}${path.sep}`);
    });

    test("leaves out Mate's bundled plugin reached through a symlink", async () => {
      const bundled = await bundledPlugin();
      const alias = path.join(await makeRoot(), "mate-link");
      await fs.symlink(bundled, alias);

      await expectBundledPluginLeftOut(bundled, alias);
    });

    test("warns once for Mate's bundled plugin declared by two Capabilities", async () => {
      const bundled = await bundledPlugin();

      const gathered = await gatherClaudePluginDirectories(
        [declaring("acme", true, bundled), declaring("beta", true, `${bundled}${path.sep}`)],
        bundled,
      );

      expect(gathered.directories).toEqual([]);
      expect(gathered.warnings).toHaveLength(1);
      expect(gathered.warnings[0]).toContain("acme");
    });

    test("leaves out a folder whose manifest uses Mate's plugin name, with a warning", async () => {
      const root = await makeRoot();
      const impostor = await mateNamedFolder(root, "acme");
      const own = await pluginFolder(root, "own");

      const gathered = await gatherClaudePluginDirectories(
        [declaring("acme", true, impostor, own)],
        BUNDLED_ELSEWHERE,
      );

      expect(gathered.directories).toEqual([own]);
      expect(gathered.warnings).toHaveLength(1);
      expect(gathered.warnings[0]).toContain("acme");
      expect(gathered.warnings[0]).toContain(impostor);
      expect(gathered.warnings[0]).toContain(MATE_CLAUDE_PLUGIN_NAME);
    });

    test("returns a folder whose manifest does not parse or has no name", async () => {
      const root = await makeRoot();
      const unparseable = await folderWithManifest(root, "unparseable", "{ not json\n");
      const unnamed = await folderWithManifest(root, "unnamed", "{}\n");

      const gathered = await gatherClaudePluginDirectories(
        [declaring("acme", true, unparseable, unnamed)],
        BUNDLED_ELSEWHERE,
      );

      expect(gathered).toEqual({ directories: [unparseable, unnamed], warnings: [] });
    });
  });
});

describe("describeClaudePluginDirectories", () => {
  test("names Mate's bundled plugin and a folder using Mate's plugin name as left out", async () => {
    const root = await makeRoot();
    const bundled = await pluginFolder(root, MATE_CLAUDE_PLUGIN_NAME);
    const impostor = await mateNamedFolder(root, "impostor");
    const own = await pluginFolder(root, "own");

    const reports = await describeClaudePluginDirectories(
      [declaring("acme", true, bundled, impostor), declaring("beta", true, own)],
      bundled,
    );

    expect(reports).toEqual([
      { capability: "acme", path: bundled, loadable: false, problem: "bundled-mate-plugin" },
      { capability: "acme", path: impostor, loadable: false, problem: "mate-plugin-name" },
      { capability: "beta", path: own, loadable: true },
    ]);
  });
});
