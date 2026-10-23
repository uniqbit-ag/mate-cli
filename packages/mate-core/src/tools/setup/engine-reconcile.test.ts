import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { getClaudePluginRoot } from "../../lib/package-paths";
import { buildSetupInstallationPlan, executeSetupInstallationPlan } from "./engine";
import type { CapabilityPlugin, ProviderPlugin, SetupContext } from "./plugin";

const tempRoots: string[] = [];

async function makeCompanion(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "engine-reconcile-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function fakeProvider(id: string, log: string[]): ProviderPlugin {
  return {
    id,
    kind: "provider",
    label: id,
    description: id,
    defaultSelected: true,
    isEnabled: () => true,
    async apply() {
      log.push(`provider:${id}`);
    },
    async teardown() {},
  };
}

function declaringCapability(log: string[], enabled: boolean): CapabilityPlugin {
  return {
    id: "acme",
    kind: "capability",
    label: "Acme",
    description: "declares contributions",
    defaultSelected: false,
    isEnabled: () => enabled,
    async apply() {},
    async teardown() {},
    getRuntimeContributions() {
      log.push("collect:acme");
      return {
        claude: {
          hookGroups: [
            {
              event: "PreToolUse",
              marker: "acme-hook.sh",
              group: { matcher: "Bash", hooks: [{ type: "command", command: "acme-hook.sh" }] },
            },
          ],
          permissionEntries: ["mcp__acme__*"],
        },
        opencode: {
          mcpServers: [{ name: "acme", command: "acme", args: ["serve"] }],
        },
      };
    },
  };
}

async function runPlan(companionPath: string, plugins: (ProviderPlugin | CapabilityPlugin)[]) {
  const config = { allowedAgents: ["claude", "opencode"], capabilities: [] };
  const plan = buildSetupInstallationPlan(config, plugins);
  const ctx: SetupContext = {
    companionPath,
    config,
    mode: "setup",
    activeProviders: plan.activeProviders,
  };
  return executeSetupInstallationPlan(ctx, plugins, plan);
}

/** A Capability shipping a Claude plugin folder, written where Claude would load it. */
async function pluginFolderCapability(
  id: string,
  root: string,
  enabled: boolean,
): Promise<{ capability: CapabilityPlugin; folder: string }> {
  const folder = path.join(root, "plugins", id);
  await fs.mkdir(path.join(folder, ".claude-plugin"), { recursive: true });
  await fs.writeFile(path.join(folder, ".claude-plugin", "plugin.json"), `{"name":"${id}"}\n`);
  return {
    folder,
    capability: {
      id,
      kind: "capability",
      label: id,
      description: "ships a Claude plugin folder",
      defaultSelected: false,
      isEnabled: () => enabled,
      async apply() {},
      async teardown() {},
      getRuntimeContributions: () => ({ claude: { pluginDirectories: [{ path: folder }] } }),
    },
  };
}

describe("engine contribution reconciliation", () => {
  test("enabled capability contributions reach every active runtime after providers", async () => {
    const companionPath = await makeCompanion();
    const log: string[] = [];

    await runPlan(companionPath, [
      fakeProvider("claude", log),
      fakeProvider("opencode", log),
      declaringCapability(log, true),
    ]);

    expect(log.indexOf("provider:claude")).toBeLessThan(log.indexOf("collect:acme"));
    expect(log.indexOf("provider:opencode")).toBeLessThan(log.indexOf("collect:acme"));

    const settings = JSON.parse(
      await fs.readFile(path.join(companionPath, ".claude", "settings.local.json"), "utf8"),
    ) as { hooks: Record<string, unknown[]>; permissions: { allow: string[] } };
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "acme-hook.sh" }] },
    ]);
    expect(settings.permissions.allow).toContain("mcp__acme__*");

    const opencodeConfig = JSON.parse(
      await fs.readFile(path.join(companionPath, ".opencode", "opencode.json"), "utf8"),
    ) as { mcp: { servers: Record<string, unknown> } };
    expect(opencodeConfig.mcp.servers.acme).toEqual({
      type: "local",
      command: ["acme", "serve"],
      disabled: false,
    });
  });

  test("disabled capability contributions are torn down through each runtime", async () => {
    const companionPath = await makeCompanion();
    const log: string[] = [];

    await runPlan(companionPath, [
      fakeProvider("claude", log),
      fakeProvider("opencode", log),
      declaringCapability(log, true),
    ]);
    await runPlan(companionPath, [
      fakeProvider("claude", log),
      fakeProvider("opencode", log),
      declaringCapability(log, false),
    ]);

    const settings = JSON.parse(
      await fs.readFile(path.join(companionPath, ".claude", "settings.local.json"), "utf8"),
    ) as { hooks?: Record<string, unknown[]>; permissions?: { allow?: string[] } };
    expect(settings.hooks?.PreToolUse).toBeUndefined();
    expect(settings.permissions?.allow ?? []).not.toContain("mcp__acme__*");

    const opencodeConfig = JSON.parse(
      await fs.readFile(path.join(companionPath, ".opencode", "opencode.json"), "utf8"),
    ) as { mcp?: Record<string, unknown> };
    expect(opencodeConfig.mcp).toBeUndefined();
  });

  test("the pass returns enabled Capabilities' Claude plugin folders and no disabled one's", async () => {
    const companionPath = await makeCompanion();
    const log: string[] = [];
    const enabled = await pluginFolderCapability("acme", companionPath, true);
    const disabled = await pluginFolderCapability("beta", companionPath, false);

    const outcome = await runPlan(companionPath, [
      fakeProvider("claude", log),
      enabled.capability,
      disabled.capability,
    ]);

    expect(outcome.claudePluginFolders.launch).toEqual([enabled.folder]);
    expect(outcome.claudePluginFolders.loadWarnings).toEqual([]);
  });

  test("the pass leaves out Mate's bundled plugin, which the launch passes already", async () => {
    const companionPath = await makeCompanion();
    const { capability } = await pluginFolderCapability("acme", companionPath, true);
    const declaringBundled: CapabilityPlugin = {
      ...capability,
      getRuntimeContributions: () => ({
        claude: { pluginDirectories: [{ path: getClaudePluginRoot() }] },
      }),
    };

    const outcome = await runPlan(companionPath, [fakeProvider("claude", []), declaringBundled]);

    expect(outcome.claudePluginFolders.launch).toEqual([]);
    expect(outcome.claudePluginFolders.loadWarnings).toEqual([
      expect.stringContaining(getClaudePluginRoot()),
    ]);
  });

  test("a gathered plugin folder is named in no runtime file and printed by no warning", async () => {
    const companionPath = await makeCompanion();
    const log: string[] = [];
    const { capability } = await pluginFolderCapability("acme", companionPath, true);
    const broken: CapabilityPlugin = {
      ...capability,
      id: "broken",
      getRuntimeContributions: () => ({
        claude: { pluginDirectories: [{ path: path.join(companionPath, "nowhere") }] },
      }),
    };

    const outcome = await runPlan(companionPath, [
      fakeProvider("claude", log),
      fakeProvider("opencode", log),
      capability,
      broken,
    ]);

    expect(outcome.claudePluginFolders.loadWarnings).toHaveLength(1);
    expect(outcome.warnings).toEqual([]);
    const written = await Promise.all(
      [".claude/settings.local.json", ".mcp.json", "CLAUDE.md"].map((file) =>
        fs.readFile(path.join(companionPath, file), "utf8").catch(() => ""),
      ),
    );
    for (const content of written) {
      expect(content).not.toContain("plugins/acme");
      expect(content).not.toContain("nowhere");
    }
  });

  test("the pass publishes enabled folders as their own marketplace and withdraws it on disable", async () => {
    const companionPath = await makeCompanion();
    const enabled = await pluginFolderCapability("acme", companionPath, true);
    const disabled = await pluginFolderCapability("beta", companionPath, false);
    const marketplace = (folder: string) =>
      fs
        .readFile(path.join(folder, ".claude-plugin", "marketplace.json"), "utf8")
        .then((text) => JSON.parse(text) as { name: string })
        .catch(() => undefined);

    await runPlan(companionPath, [
      fakeProvider("claude", []),
      enabled.capability,
      disabled.capability,
    ]);
    const published = await marketplace(enabled.folder);
    await runPlan(companionPath, [
      fakeProvider("claude", []),
      { ...enabled.capability, isEnabled: () => false },
    ]);

    expect(published?.name).toBe("mate-plugin-acme");
    expect(await marketplace(disabled.folder)).toBeUndefined();
    expect(await marketplace(enabled.folder)).toBeUndefined();
  });

  test("the pass warns of a folder plain sessions cannot load, and leaves its file alone", async () => {
    const companionPath = await makeCompanion();
    const { capability, folder } = await pluginFolderCapability("acme", companionPath, true);
    const foreign = path.join(folder, ".claude-plugin", "marketplace.json");
    await fs.writeFile(foreign, `{"name":"tools","owner":{"name":"Acme"},"plugins":[]}\n`);

    const outcome = await runPlan(companionPath, [fakeProvider("claude", []), capability]);

    expect(outcome.claudePluginFolders.launch).toEqual([folder]);
    expect(outcome.claudePluginFolders.loadWarnings).toEqual([]);
    expect(
      outcome.claudePluginFolders.publication?.unpublished.map((entry) => entry.warning),
    ).toEqual([
      expect.stringMatching(
        /^acme: Claude plugin folder .* plain `claude` sessions do not load it\.$/,
      ),
    ]);
    expect(await fs.readFile(foreign, "utf8")).toBe(
      `{"name":"tools","owner":{"name":"Acme"},"plugins":[]}\n`,
    );
  });
});
