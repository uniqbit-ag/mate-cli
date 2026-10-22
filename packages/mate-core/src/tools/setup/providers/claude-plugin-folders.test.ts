import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { MATE_CLAUDE_PLUGIN_NAME } from "../../../lib/package-paths";
import type { CapabilityContributionInput } from "../plugin";
import {
  CLAUDE_PLUGIN_MARKETPLACE,
  inspectClaudePluginFolders,
  publishClaudePluginFolders,
  readClaudeUserMarketplaces,
  type ClaudeUserMarketplaces,
} from "./claude-plugin-folders";

const tempRoots: string[] = [];

/** Mate's bundled plugin for tests that declare no folder resolving to it. */
const BUNDLED_ELSEWHERE = path.join(os.tmpdir(), "mate-bundled-claude-plugin-elsewhere");
const NO_USER_MARKETPLACES: ClaudeUserMarketplaces = new Map();

/** Root bypasses file modes, so an unwritable folder cannot be simulated. */
const RUNS_AS_ROOT = process.getuid?.() === 0;

async function makeRoot(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugin-folders-")));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempRoots.splice(0)) {
    await fs.chmod(dir, 0o755).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** A folder holding `manifest` as its Claude plugin manifest. */
async function folderWithManifest(root: string, name: string, manifest: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, ".claude-plugin"), { recursive: true });
  await fs.writeFile(path.join(dir, ".claude-plugin", "plugin.json"), manifest);
  return dir;
}

/** A plugin folder named `plugin`, optionally holding `marketplace` as its marketplace file. */
async function pluginFolder(root: string, plugin: string, marketplace?: unknown): Promise<string> {
  const dir = await folderWithManifest(
    root,
    plugin.replace(/[^A-Za-z0-9._ -]/g, "_"),
    JSON.stringify({ name: plugin }),
  );
  if (marketplace !== undefined) {
    await fs.writeFile(
      path.join(dir, CLAUDE_PLUGIN_MARKETPLACE),
      typeof marketplace === "string" ? marketplace : JSON.stringify(marketplace),
    );
  }
  return dir;
}

/** A folder whose manifest claims Mate's plugin name. */
async function mateNamedFolder(root: string, name: string): Promise<string> {
  return folderWithManifest(root, name, `{"name":"${MATE_CLAUDE_PLUGIN_NAME}"}\n`);
}

async function marketplaceText(dir: string): Promise<string | undefined> {
  return fs.readFile(path.join(dir, CLAUDE_PLUGIN_MARKETPLACE), "utf8").catch(() => undefined);
}

/** Makes `dir`'s `.claude-plugin` read-only for `run`, so no marketplace file can be written there. */
async function withReadOnlyPluginDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const pluginDir = path.join(dir, ".claude-plugin");
  await fs.chmod(pluginDir, 0o555);
  try {
    return await run();
  } finally {
    await fs.chmod(pluginDir, 0o755);
  }
}

function declaring(pluginId: string, enabled: boolean, ...paths: string[]) {
  return {
    pluginId,
    enabled,
    contributions: { pluginDirectories: paths.map((dirPath) => ({ path: dirPath })) },
  } satisfies CapabilityContributionInput;
}

const options = (
  bundledPluginRoot = BUNDLED_ELSEWHERE,
  userMarketplaces = NO_USER_MARKETPLACES,
) => ({ bundledPluginRoot, userMarketplaces });

const inspect = (
  contributions: CapabilityContributionInput[],
  bundledPluginRoot?: string,
  userMarketplaces?: ClaudeUserMarketplaces,
) => inspectClaudePluginFolders(contributions, options(bundledPluginRoot, userMarketplaces));

const publish = (contributions: CapabilityContributionInput[]) =>
  publishClaudePluginFolders(contributions, options());

/** context-mode@1.0.169's own marketplace file, as shipped. */
const CONTEXT_MODE_MARKETPLACE = {
  name: "context-mode",
  owner: { name: "Mert Koseoğlu" },
  plugins: [{ name: "context-mode", source: "./" }],
};

const MATE_MARKETPLACE = {
  name: "mate-plugin-acme",
  owner: { name: "Mate" },
  plugins: [{ name: "acme", source: "./" }],
};

/** Exactly the text Mate writes for plugin `acme`. */
const MATE_MARKETPLACE_TEXT = `${JSON.stringify(MATE_MARKETPLACE, null, 2)}\n`;

describe("the launch list", () => {
  test("holds an enabled Capability's folder", async () => {
    const folder = await pluginFolder(await makeRoot(), "acme");

    const folders = await inspect([declaring("acme", true, folder)]);

    expect(folders.launch).toEqual([folder]);
    expect(folders.loadWarnings).toEqual([]);
  });

  test("holds no disabled Capability's folder", async () => {
    const folder = await pluginFolder(await makeRoot(), "acme");

    const folders = await inspect([declaring("acme", false, folder)]);

    expect(folders).toEqual({ launch: [], loadWarnings: [], published: [], report: [] });
  });

  test("keeps Capability registration order", async () => {
    const root = await makeRoot();
    const first = await pluginFolder(root, "zeta");
    const second = await pluginFolder(root, "alpha");

    const folders = await inspect([
      declaring("zeta", true, first),
      declaring("alpha", true, second),
    ]);

    expect(folders.launch).toEqual([first, second]);
  });

  test("leaves out a folder that holds no plugin manifest, with a warning", async () => {
    const root = await makeRoot();
    const empty = path.join(root, "empty");
    await fs.mkdir(empty);
    const missing = path.join(root, "missing");

    const folders = await inspect([declaring("acme", true, empty, missing)]);

    expect(folders.launch).toEqual([]);
    expect(folders.loadWarnings).toEqual([
      `acme: Claude plugin folder ${empty} holds no ${path.join(".claude-plugin", "plugin.json")}; it was left out.`,
      `acme: Claude plugin folder ${missing} holds no ${path.join(".claude-plugin", "plugin.json")}; it was left out.`,
    ]);
  });

  test("leaves out a relative path, with a warning", async () => {
    const folders = await inspect([declaring("acme", true, "plugins/acme")]);

    expect(folders.launch).toEqual([]);
    expect(folders.loadWarnings).toEqual([
      "acme: Claude plugin folder plugins/acme is not an absolute path; it was left out.",
    ]);
  });

  test("holds a folder declared twice once, at its first declaration", async () => {
    const root = await makeRoot();
    const shared = await pluginFolder(root, "shared");
    const own = await pluginFolder(root, "own");

    const folders = await inspect([
      declaring("acme", true, shared),
      declaring("beta", true, own, shared),
    ]);

    expect(folders.launch).toEqual([shared, own]);
    expect(folders.loadWarnings).toEqual([]);
  });

  test("holds a folder spelled with a trailing separator once, without the separator", async () => {
    const folder = await pluginFolder(await makeRoot(), "acme");

    const folders = await inspect([
      declaring("acme", true, `${folder}${path.sep}`),
      declaring("beta", true, folder),
    ]);

    expect(folders.launch).toEqual([folder]);
  });

  test("holds a folder reached through a symlink once, at its first declaration", async () => {
    const root = await makeRoot();
    const folder = await pluginFolder(root, "acme");
    const alias = path.join(root, "acme-link");
    await fs.symlink(folder, alias);

    const folders = await inspect([
      declaring("acme", true, alias),
      declaring("beta", true, folder),
    ]);

    expect(folders.launch).toEqual([alias]);
  });

  test("warns once for a missing folder declared twice", async () => {
    const missing = path.join(await makeRoot(), "missing");

    const folders = await inspect([
      declaring("acme", true, missing),
      declaring("beta", true, `${missing}${path.sep}`),
    ]);

    expect(folders.launch).toEqual([]);
    expect(folders.loadWarnings).toHaveLength(1);
  });

  test("holds a path that contains a space unchanged", async () => {
    const folder = await pluginFolder(await makeRoot(), "My Plugins");

    expect((await inspect([declaring("acme", true, folder)])).launch).toEqual([folder]);
  });

  test("a Capability without plugin folders contributes nothing", async () => {
    const folders = await inspect([
      { pluginId: "acme", enabled: true, contributions: { permissionEntries: ["mcp__acme__*"] } },
    ]);

    expect(folders).toEqual({ launch: [], loadWarnings: [], published: [], report: [] });
  });

  describe("Mate's own plugin", () => {
    /** Mate's bundled plugin, as the launch passes it before every gathered folder. */
    async function bundledPlugin(): Promise<string> {
      return pluginFolder(await makeRoot(), MATE_CLAUDE_PLUGIN_NAME);
    }

    async function expectBundledPluginLeftOut(bundled: string, declared: string): Promise<void> {
      const folders = await inspect([declaring("acme", true, declared)], bundled);

      expect(folders.launch).toEqual([]);
      expect(folders.loadWarnings).toEqual([
        `acme: Claude plugin folder ${declared} is Mate's bundled plugin, which every managed launch loads already; it was left out.`,
      ]);
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

      const folders = await inspect(
        [declaring("acme", true, bundled), declaring("beta", true, `${bundled}${path.sep}`)],
        bundled,
      );

      expect(folders.launch).toEqual([]);
      expect(folders.loadWarnings).toHaveLength(1);
      expect(folders.loadWarnings[0]).toStartWith("acme:");
    });

    test("leaves out a folder whose manifest uses Mate's plugin name, with a warning", async () => {
      const root = await makeRoot();
      const impostor = await mateNamedFolder(root, "acme");
      const own = await pluginFolder(root, "own");

      const folders = await inspect([declaring("acme", true, impostor, own)]);

      expect(folders.launch).toEqual([own]);
      expect(folders.loadWarnings).toEqual([
        `acme: Claude plugin folder ${impostor} uses Mate's plugin name ${MATE_CLAUDE_PLUGIN_NAME}; it was left out so it cannot replace Mate's guardrail hooks.`,
      ]);
    });

    test("holds a folder whose manifest does not parse or has no name", async () => {
      const root = await makeRoot();
      const unparseable = await folderWithManifest(root, "unparseable", "{ not json\n");
      const unnamed = await folderWithManifest(root, "unnamed", "{}\n");

      const folders = await inspect([declaring("acme", true, unparseable, unnamed)]);

      expect(folders.launch).toEqual([unparseable, unnamed]);
      expect(folders.loadWarnings).toEqual([]);
    });
  });
});

describe("publication, as an inspection reports it", () => {
  test.each([
    {
      label: "an author's marketplace listing the plugin in place",
      plugin: "context-mode",
      marketplace: CONTEXT_MODE_MARKETPLACE as unknown,
      published: { plugin: "context-mode", marketplace: "context-mode" },
      report: { marketplace: "context-mode" },
    },
    {
      label: "an author's marketplace listing it as `.`",
      plugin: "acme",
      marketplace: {
        name: "acme-tools",
        owner: { name: "Acme" },
        plugins: [{ name: "acme", source: "." }],
      },
      published: { plugin: "acme", marketplace: "acme-tools" },
      report: { marketplace: "acme-tools" },
    },
    {
      label: "Mate's current marketplace",
      plugin: "acme",
      marketplace: MATE_MARKETPLACE_TEXT,
      published: { plugin: "acme", marketplace: "mate-plugin-acme" },
      report: { marketplace: "mate-plugin-acme" },
    },
    {
      label: "a stale marketplace of Mate's, which is pending",
      plugin: "acme",
      marketplace: { ...MATE_MARKETPLACE, name: "mate-plugin-old" },
      report: { marketplace: "mate-plugin-acme" },
    },
    {
      label: "Mate's marketplace with other formatting, which is pending",
      plugin: "acme",
      marketplace: MATE_MARKETPLACE,
      report: { marketplace: "mate-plugin-acme" },
    },
    {
      label: "no marketplace, which is pending",
      plugin: "acme",
      marketplace: undefined,
      report: { marketplace: "mate-plugin-acme" },
    },
    {
      label: "a foreign marketplace listing other plugins",
      plugin: "acme",
      marketplace: {
        name: "acme-tools",
        owner: { name: "Acme" },
        plugins: [{ name: "other", source: "./" }],
      },
      report: { unpublishedReason: "foreign-marketplace" },
    },
    {
      label: "a foreign marketplace listing the plugin elsewhere",
      plugin: "acme",
      marketplace: {
        name: "acme-tools",
        owner: { name: "Acme" },
        plugins: [{ name: "acme", source: "./sub" }],
      },
      report: { unpublishedReason: "foreign-marketplace" },
    },
    {
      label: "an unparseable marketplace",
      plugin: "acme",
      marketplace: "{ not json",
      report: { unpublishedReason: "foreign-marketplace" },
    },
    ...["github", "claude-plugins-official", "claudeai-acme", "has space", "-leading"].map(
      (name) => ({
        label: `an author's marketplace under the name ${name}, which Claude Code refuses`,
        plugin: "acme",
        marketplace: { name, owner: { name: "Acme" }, plugins: [{ name: "acme", source: "./" }] },
        report: { unpublishedReason: "foreign-marketplace" },
      }),
    ),
    {
      label: "a plugin name that cannot form a marketplace name",
      plugin: "acme tools",
      marketplace: undefined,
      report: { unpublishedReason: "invalid-marketplace-name" },
    },
  ])("$label", async ({ plugin, marketplace, published, report }) => {
    const dir = await pluginFolder(await makeRoot(), plugin, marketplace);

    const folders = await inspect([declaring("cap", true, dir)]);

    expect(folders.launch).toEqual([dir]);
    expect(folders.published).toEqual(published ? [{ path: dir, ...published }] : []);
    expect(folders.report).toEqual([{ capability: "cap", path: dir, loadable: true, ...report }]);
    expect(folders.publication).toBeUndefined();
  });

  test("a marketplace name the user declares with another source is a name conflict", async () => {
    const dir = await pluginFolder(await makeRoot(), "context-mode", CONTEXT_MODE_MARKETPLACE);
    const user = new Map([["context-mode", [{ source: "github", repo: "mksglu/context-mode" }]]]);

    const folders = await inspect([declaring("cm", true, dir)], BUNDLED_ELSEWHERE, user);

    expect(folders.published).toEqual([]);
    expect(folders.report).toEqual([
      { capability: "cm", path: dir, loadable: true, unpublishedReason: "name-conflict" },
    ]);
  });

  test("a user record of this very folder is no conflict", async () => {
    const dir = await pluginFolder(await makeRoot(), "acme", MATE_MARKETPLACE_TEXT);
    const user = new Map([["mate-plugin-acme", [{ source: "directory", path: `${dir}/` }]]]);

    const folders = await inspect([declaring("acme", true, dir)], BUNDLED_ELSEWHERE, user);

    expect(folders.published).toEqual([
      { path: dir, plugin: "acme", marketplace: "mate-plugin-acme" },
    ]);
  });

  test("the second folder publishing one marketplace name is a name conflict", async () => {
    const root = await makeRoot();
    const first = await pluginFolder(path.join(root, "a"), "acme");
    const second = await pluginFolder(path.join(root, "b"), "acme");

    const folders = await inspect([declaring("one", true, first), declaring("two", true, second)]);

    expect(folders.report).toEqual([
      { capability: "one", path: first, loadable: true, marketplace: "mate-plugin-acme" },
      { capability: "two", path: second, loadable: true, unpublishedReason: "name-conflict" },
    ]);
  });

  test("reports every declaration, a folder declared twice claiming its name once", async () => {
    const dir = await pluginFolder(await makeRoot(), "acme");

    const folders = await inspect([declaring("one", true, dir), declaring("two", true, `${dir}/`)]);

    expect(folders.report).toEqual([
      { capability: "one", path: dir, loadable: true, marketplace: "mate-plugin-acme" },
      { capability: "two", path: `${dir}/`, loadable: true, marketplace: "mate-plugin-acme" },
    ]);
  });

  test("reports Mate's bundled plugin and a folder using Mate's plugin name as left out", async () => {
    const root = await makeRoot();
    const bundled = await pluginFolder(root, MATE_CLAUDE_PLUGIN_NAME);
    const impostor = await mateNamedFolder(root, "impostor");
    const own = await pluginFolder(root, "own");

    const folders = await inspect(
      [declaring("acme", true, bundled, impostor), declaring("beta", true, own)],
      bundled,
    );

    expect(folders.report).toEqual([
      { capability: "acme", path: bundled, loadable: false, problem: "bundled-mate-plugin" },
      { capability: "acme", path: impostor, loadable: false, problem: "mate-plugin-name" },
      { capability: "beta", path: own, loadable: true, marketplace: "mate-plugin-own" },
    ]);
  });

  test("writes nothing", async () => {
    const dir = await pluginFolder(await makeRoot(), "acme");

    await inspect([declaring("acme", true, dir)]);

    expect(await marketplaceText(dir)).toBeUndefined();
  });
});

describe("publishClaudePluginFolders", () => {
  test("writes Mate's marketplace into a folder without one, byte-stable across passes", async () => {
    const dir = await pluginFolder(await makeRoot(), "acme");

    const first = await publish([declaring("acme-cap", true, dir)]);
    const written = await marketplaceText(dir);
    const stat = await fs.stat(path.join(dir, CLAUDE_PLUGIN_MARKETPLACE));
    await publish([declaring("acme-cap", true, dir)]);

    expect(written).toBe(MATE_MARKETPLACE_TEXT);
    expect(await marketplaceText(dir)).toBe(written);
    expect((await fs.stat(path.join(dir, CLAUDE_PLUGIN_MARKETPLACE))).mtimeMs).toBe(stat.mtimeMs);
    expect(first.published).toEqual([
      { path: dir, plugin: "acme", marketplace: "mate-plugin-acme" },
    ]);
    expect(first.publication).toEqual({ unpublished: [], warnings: [] });
  });

  test("rewrites a stale marketplace of Mate's and publishes it", async () => {
    const dir = await pluginFolder(await makeRoot(), "acme", {
      ...MATE_MARKETPLACE,
      name: "mate-plugin-old",
    });

    const folders = await publish([declaring("acme-cap", true, dir)]);

    expect(await marketplaceText(dir)).toBe(MATE_MARKETPLACE_TEXT);
    expect(folders.published).toEqual([
      { path: dir, plugin: "acme", marketplace: "mate-plugin-acme" },
    ]);
  });

  test("never touches an author's or a foreign marketplace", async () => {
    const root = await makeRoot();
    const author = await pluginFolder(root, "context-mode", CONTEXT_MODE_MARKETPLACE);
    const foreign = await pluginFolder(root, "acme", "{ not json");
    const authorText = await marketplaceText(author);

    const folders = await publish([
      declaring("cm", true, author),
      declaring("acme", true, foreign),
    ]);
    await publish([declaring("cm", false, author), declaring("acme", false, foreign)]);

    expect(await marketplaceText(author)).toBe(authorText);
    expect(await marketplaceText(foreign)).toBe("{ not json");
    expect(folders.published).toEqual([
      { path: author, plugin: "context-mode", marketplace: "context-mode" },
    ]);
    expect(folders.publication?.unpublished).toEqual([
      {
        capability: "acme",
        path: foreign,
        reason: "foreign-marketplace",
        detail: `holds a ${CLAUDE_PLUGIN_MARKETPLACE} that Mate did not write and that does not list the plugin in place`,
        warning: `acme: Claude plugin folder ${foreign} holds a ${CLAUDE_PLUGIN_MARKETPLACE} that Mate did not write and that does not list the plugin in place; plain \`claude\` sessions do not load it.`,
      },
    ]);
  });

  test("removes Mate's marketplace once only disabled Capabilities declare the folder", async () => {
    const dir = await pluginFolder(await makeRoot(), "acme");
    await publish([declaring("acme-cap", true, dir)]);

    await publish([declaring("acme-cap", false, dir), declaring("other", true, dir)]);
    const keptWhileDeclared = await marketplaceText(dir);
    await publish([declaring("acme-cap", false, dir)]);

    expect(keptWhileDeclared).toBeDefined();
    expect(await marketplaceText(dir)).toBeUndefined();
  });

  test("writes nothing for a plugin name that cannot form a marketplace name", async () => {
    const dir = await pluginFolder(await makeRoot(), "acme tools");

    const folders = await publish([declaring("acme", true, dir)]);

    expect(await marketplaceText(dir)).toBeUndefined();
    expect(folders.publication?.unpublished).toEqual([
      expect.objectContaining({
        reason: "invalid-marketplace-name",
        detail: "has a plugin name that cannot form a Claude Code marketplace name",
      }),
    ]);
  });

  test.skipIf(RUNS_AS_ROOT)(
    "names an unwritable folder once, as unpublished with the write error",
    async () => {
      const dir = await pluginFolder(await makeRoot(), "acme");

      const folders = await withReadOnlyPluginDir(dir, () =>
        publish([declaring("acme-cap", true, dir)]),
      );

      expect(folders.launch).toEqual([dir]);
      expect(folders.published).toEqual([]);
      expect(folders.publication?.warnings).toEqual([]);
      expect(folders.publication?.unpublished).toHaveLength(1);
      const [entry] = folders.publication!.unpublished;
      expect(entry).toMatchObject({
        capability: "acme-cap",
        path: dir,
        reason: "missing-marketplace",
      });
      expect(entry!.warning).toStartWith(
        `acme-cap: Claude plugin folder ${dir} holds no current ${CLAUDE_PLUGIN_MARKETPLACE}, and Mate could not write one (`,
      );
      expect(entry!.warning).toContain(path.join(dir, CLAUDE_PLUGIN_MARKETPLACE));
      expect(entry!.warning).toEndWith("; plain `claude` sessions do not load it.");
    },
  );

  test.skipIf(RUNS_AS_ROOT)(
    "does not publish a stale marketplace of Mate's it cannot rewrite",
    async () => {
      const dir = await pluginFolder(await makeRoot(), "acme", {
        ...MATE_MARKETPLACE,
        name: "mate-plugin-old",
      });
      const file = path.join(dir, CLAUDE_PLUGIN_MARKETPLACE);
      await fs.chmod(file, 0o444);

      const folders = await publish([declaring("acme-cap", true, dir)]);
      await fs.chmod(file, 0o644);

      expect(folders.launch).toEqual([dir]);
      expect(folders.published).toEqual([]);
      expect(folders.publication?.unpublished).toEqual([
        expect.objectContaining({ path: dir, reason: "missing-marketplace" }),
      ]);
    },
  );

  test.skipIf(RUNS_AS_ROOT)("warns when Mate's file cannot be removed", async () => {
    const root = await makeRoot();
    const dir = await pluginFolder(root, "acme");
    await publish([declaring("acme-cap", true, dir)]);

    const folders = await withReadOnlyPluginDir(dir, () =>
      publish([declaring("acme-cap", false, dir)]),
    );

    expect(folders.publication?.warnings).toHaveLength(1);
    expect(folders.publication?.warnings[0]).toStartWith(
      `acme-cap: could not remove ${path.join(dir, CLAUDE_PLUGIN_MARKETPLACE)}`,
    );
  });
});

describe("readClaudeUserMarketplaces", () => {
  test("reads user settings, and Claude's record of every non-directory source", async () => {
    const configDir = await makeRoot();
    await fs.mkdir(path.join(configDir, "plugins"));
    await fs.writeFile(
      path.join(configDir, "settings.json"),
      JSON.stringify({
        extraKnownMarketplaces: { mine: { source: { source: "directory", path: "/mine" } } },
      }),
    );
    await fs.writeFile(
      path.join(configDir, "plugins", "known_marketplaces.json"),
      JSON.stringify({
        "context-mode": { source: { source: "github", repo: "mksglu/context-mode" } },
        "mate-plugin-acme": { source: { source: "directory", path: "/other/acme" } },
      }),
    );

    const marketplaces = await readClaudeUserMarketplaces({ CLAUDE_CONFIG_DIR: configDir });

    expect([...marketplaces.keys()].sort()).toEqual(["context-mode", "mine"]);
  });

  test("reads nothing from an absent configuration", async () => {
    const marketplaces = await readClaudeUserMarketplaces({
      CLAUDE_CONFIG_DIR: path.join(await makeRoot(), "absent"),
    });

    expect(marketplaces.size).toBe(0);
  });
});
