import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { resetActiveDistribution, setActiveDistribution } from "../../distribution";
import type { FrameworkConfig } from "../../lib/orchestrator/types";
import { PluginRegistry } from "./registry";
import { executeSetupInstallationPlan, buildSetupInstallationPlan } from "./engine";
import { createClaudePlugin } from "./providers/claude";
import { createOpenCodePlugin } from "./providers/opencode";
import type { CapabilityPlugin, SetupContext } from "./plugin";

const tempRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-setup-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  resetActiveDistribution();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("hub setup scope", () => {
  test("runs providers and MCP reconciliation without companion surfaces", async () => {
    const hubPath = await makeTempDir();
    let capabilityApplied = false;
    const capability: CapabilityPlugin = {
      id: "acme-mcp",
      kind: "capability",
      label: "Acme MCP",
      description: "hub MCP fixture",
      defaultSelected: false,
      isEnabled: () => true,
      apply: async () => {
        capabilityApplied = true;
      },
      teardown: async () => {},
      getRuntimeContributions: (_ctx: SetupContext) => ({
        claude: { mcpServers: [{ name: "acme", command: "acme", args: ["serve"] }] },
        opencode: { mcpServers: [{ name: "acme", command: "acme", args: ["serve"] }] },
      }),
    };
    const config: FrameworkConfig = {
      type: "hub",
      allowedAgents: ["claude", "opencode"],
      packageManagers: [],
      capabilities: [],
    };
    const registry = new PluginRegistry([createClaudePlugin(), createOpenCodePlugin(), capability]);
    setActiveDistribution({ config: { runtime: "bun", version: "test" }, registry });

    const registrations = registry.getEntries();
    const plan = buildSetupInstallationPlan(config, registrations);
    await executeSetupInstallationPlan(
      {
        companionPath: hubPath,
        config,
        mode: "setup",
        activeProviders: plan.activeProviders,
        scope: "hub",
      },
      registrations,
      plan,
    );

    expect(capabilityApplied).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(hubPath, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: { acme: { command: "acme", args: ["serve"] } },
    });
    expect(
      JSON.parse(await fs.readFile(path.join(hubPath, ".opencode", "opencode.json"), "utf8")),
    ).toEqual({
      mcp: {
        servers: {
          acme: { type: "local", command: ["acme", "serve"], disabled: false },
        },
      },
    });
    await fs.access(path.join(hubPath, ".claude", "settings.local.json"));

    for (const file of [
      "AGENTS.md",
      "CLAUDE.md",
      ".gitignore",
      path.join(".opencode", "tui.json"),
    ]) {
      await expect(fs.access(path.join(hubPath, file))).rejects.toThrow();
    }
  });

  test("materializes and prunes agent definition files without other companion surfaces", async () => {
    const hubPath = await makeTempDir();
    const capability: CapabilityPlugin = {
      id: "acme-agent",
      kind: "capability",
      label: "Acme Agent",
      description: "hub agent-definition fixture",
      defaultSelected: false,
      isEnabled: () => true,
      apply: async () => {},
      teardown: async () => {},
      getRuntimeContributions: (_ctx: SetupContext) => ({
        claude: {
          agentDefinitions: [{ name: "acme", content: "---\nname: acme\n---\nAcme agent body.\n" }],
        },
        opencode: {
          agentDefinitions: [{ name: "acme", content: "---\nmode: primary\n---\nAcme agent.\n" }],
        },
      }),
    };
    const config: FrameworkConfig = {
      type: "hub",
      allowedAgents: ["claude", "opencode"],
      packageManagers: [],
      capabilities: [],
    };
    const registry = new PluginRegistry([createClaudePlugin(), createOpenCodePlugin(), capability]);
    setActiveDistribution({ config: { runtime: "bun", version: "test" }, registry });

    const registrations = registry.getEntries();
    const baseCtx: SetupContext = {
      companionPath: hubPath,
      config,
      mode: "setup",
      activeProviders: buildSetupInstallationPlan(config, registrations).activeProviders,
      scope: "hub",
    };
    await executeSetupInstallationPlan(
      baseCtx,
      registrations,
      buildSetupInstallationPlan(config, registrations),
    );

    expect(await fs.readFile(path.join(hubPath, ".claude", "agents", "acme.md"), "utf8")).toBe(
      "---\nname: acme\n---\nAcme agent body.\n",
    );
    expect(await fs.readFile(path.join(hubPath, ".opencode", "agents", "acme.md"), "utf8")).toBe(
      "---\nmode: primary\n---\nAcme agent.\n",
    );

    // Disabling the capability tears the files back down, hub scope or not.
    const disabledCapability: CapabilityPlugin = { ...capability, isEnabled: () => false };
    const disabledRegistry = new PluginRegistry([
      createClaudePlugin(),
      createOpenCodePlugin(),
      disabledCapability,
    ]);
    setActiveDistribution({
      config: { runtime: "bun", version: "test" },
      registry: disabledRegistry,
    });
    const disabledRegistrations = disabledRegistry.getEntries();
    const plan = buildSetupInstallationPlan(config, disabledRegistrations);
    await executeSetupInstallationPlan(
      { ...baseCtx, activeProviders: plan.activeProviders },
      disabledRegistrations,
      plan,
    );

    await expect(fs.access(path.join(hubPath, ".claude", "agents", "acme.md"))).rejects.toThrow();
    await expect(fs.access(path.join(hubPath, ".opencode", "agents", "acme.md"))).rejects.toThrow();
  });

  test("Claude hub teardown removes only what hub apply wrote", async () => {
    const hubPath = await makeTempDir();
    const operatorFiles = {
      "AGENTS.md": "# Acme agents\n",
      "CLAUDE.md": "# Acme claude\n",
      [path.join(".claude", "settings.json")]: '{ "acme": true }\n',
    };
    await fs.mkdir(path.join(hubPath, ".claude"), { recursive: true });
    for (const [file, content] of Object.entries(operatorFiles)) {
      await fs.writeFile(path.join(hubPath, file), content);
    }
    const config: FrameworkConfig = {
      type: "hub",
      allowedAgents: ["claude"],
      packageManagers: [],
      capabilities: [],
    };
    const claude = createClaudePlugin();
    setActiveDistribution({
      config: { runtime: "bun", version: "test" },
      registry: new PluginRegistry([claude]),
    });
    const ctx: SetupContext = {
      companionPath: hubPath,
      config,
      mode: "setup",
      activeProviders: ["claude"],
      scope: "hub",
    };

    await claude.apply(ctx);
    await claude.hosting?.mcp?.register(ctx, { name: "acme", command: "acme", args: ["serve"] });
    await fs.access(path.join(hubPath, ".claude", "settings.local.json"));
    await fs.access(path.join(hubPath, ".mcp.json"));

    await claude.teardown(ctx);

    for (const [file, content] of Object.entries(operatorFiles)) {
      expect(await fs.readFile(path.join(hubPath, file), "utf8")).toBe(content);
    }
    await expect(fs.access(path.join(hubPath, ".claude", "settings.local.json"))).rejects.toThrow();
    await expect(fs.access(path.join(hubPath, ".mcp.json"))).rejects.toThrow();
  });
});
