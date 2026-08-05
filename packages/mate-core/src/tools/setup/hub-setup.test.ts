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
      mcp: { acme: { type: "local", command: ["acme", "serve"], enabled: true } },
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
});
