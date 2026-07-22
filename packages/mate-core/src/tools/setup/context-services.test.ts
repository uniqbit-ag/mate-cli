import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { applySetupCompatibilities } from "../setup";
import type { CapabilityPlugin, McpServerDescriptor, Plugin } from "./plugin";
import { createClaudePlugin } from "./providers/claude";
import { createOpenCodePlugin } from "./providers/opencode";

const claudePlugin = createClaudePlugin();
const opencodePlugin = createOpenCodePlugin();

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function mcpCapability(descriptor: McpServerDescriptor): CapabilityPlugin {
  return {
    id: "acme-mcp",
    kind: "capability",
    label: "Acme MCP",
    description: "",
    defaultSelected: false,
    isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "acme-mcp"),
    async apply(ctx) {
      await ctx.mcp?.register(descriptor);
    },
    async teardown() {},
  };
}

function configWith(capabilities: string[], agents: string[] = ["claude", "opencode"]) {
  return {
    profiles: { default: { name: "default", allowedAgents: agents } },
    capabilities: capabilities.map((name) => ({ name })),
  };
}

async function readJson(filePath: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function instructionsCapability(content: string): CapabilityPlugin {
  return {
    id: "acme-rules",
    kind: "capability",
    label: "Acme Rules",
    description: "",
    defaultSelected: false,
    isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "acme-rules"),
    async apply(ctx) {
      await ctx.instructions?.append(content);
    },
    async teardown() {},
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("ctx.templates.render", () => {
  function templatesCapability(
    templatePath: string,
    destination: string,
    data?: Record<string, string>,
  ): CapabilityPlugin {
    return {
      id: "acme-scaffold",
      kind: "capability",
      label: "Acme Scaffold",
      description: "",
      defaultSelected: false,
      isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "acme-scaffold"),
      async apply(ctx) {
        await ctx.templates?.render(templatePath, destination, data);
      },
      async teardown() {},
    };
  }

  test("renders a core template into the companion", async () => {
    const root = await makeTempDir("mate-tpl-core-");
    const capability = templatesCapability("root/TEMPLATE_AGENTS.md", "scaffold/AGENTS.md");

    await applySetupCompatibilities(root, configWith(["acme-scaffold"], ["claude"]), "setup", [
      claudePlugin,
      capability,
    ]);

    const rendered = await fs.readFile(path.join(root, "scaffold", "AGENTS.md"), "utf8");
    expect(rendered.trim().length).toBeGreaterThan(0);
  });

  test("distribution asset root overrides the core template and data is substituted", async () => {
    const { createMate } = await import("../../create-mate");
    const { resetActiveDistribution } = await import("../../distribution");

    const root = await makeTempDir("mate-tpl-override-");
    const overrideRoot = await makeTempDir("mate-tpl-assets-");
    await fs.mkdir(path.join(overrideRoot, "templates", "root"), { recursive: true });
    await fs.writeFile(
      path.join(overrideRoot, "templates", "root", "TEMPLATE_AGENTS.md"),
      "Hello {{name}} from the distribution override.\n",
      "utf8",
    );

    const capability = templatesCapability("root/TEMPLATE_AGENTS.md", "scaffold/AGENTS.md", {
      name: "Acme",
    });

    createMate({
      config: {
        name: "acme-mate",
        legacyNames: [],
        runtime: "bun",
        supportedAdapters: ["claude"],
        version: "1.0.0",
        assetRoots: [overrideRoot],
      },
      plugins: [claudePlugin, capability],
    });
    try {
      await applySetupCompatibilities(root, configWith(["acme-scaffold"], ["claude"]), "setup", [
        claudePlugin,
        capability,
      ]);
    } finally {
      resetActiveDistribution();
    }

    const rendered = await fs.readFile(path.join(root, "scaffold", "AGENTS.md"), "utf8");
    expect(rendered).toBe("Hello Acme from the distribution override.\n");
  });
});

describe("ctx.instructions.append", () => {
  const content = "Always use the acme-kb MCP server before answering.";

  test("instruction block lands in each active provider surface", async () => {
    const root = await makeTempDir("mate-instr-append-");
    const capability = instructionsCapability(content);

    await applySetupCompatibilities(
      root,
      { ...configWith(["acme-rules"]), capabilities: [{ name: "acme-rules" }] },
      "setup",
      [claudePlugin, opencodePlugin, capability],
    );

    const claudeMd = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain(content);
    const agentsMd = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain(content);
  });

  test("re-running apply is idempotent — block appears exactly once", async () => {
    const root = await makeTempDir("mate-instr-idempotent-");
    const capability = instructionsCapability(content);
    const plugins = [claudePlugin, opencodePlugin, capability];
    const config = configWith(["acme-rules"]);

    await applySetupCompatibilities(root, config, "setup", plugins);
    await applySetupCompatibilities(root, config, "sync", plugins);

    const claudeMd = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(countOccurrences(claudeMd, content)).toBe(1);
    const agentsMd = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(countOccurrences(agentsMd, content)).toBe(1);
  });

  test("teardown removes exactly the contributed content", async () => {
    const root = await makeTempDir("mate-instr-teardown-");
    const capability = instructionsCapability(content);
    const plugins = [claudePlugin, opencodePlugin, capability];

    await applySetupCompatibilities(root, configWith(["acme-rules"]), "setup", plugins);
    await applySetupCompatibilities(root, configWith([]), "setup", plugins);

    const claudeMd = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(claudeMd).not.toContain(content);
    // The provider's own guidance remains in place.
    expect(claudeMd.trim().length).toBeGreaterThan(0);
    const agentsMd = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agentsMd).not.toContain(content);
  });
});

describe("tokensave capability via context services", () => {
  test("registers the tokensave server in both provider configs through the engine", async () => {
    const { tokensaveDeps, createTokensavePlugin } = await import("./capabilities/tokensave");
    const tokensavePlugin = createTokensavePlugin();
    const root = await makeTempDir("mate-tokensave-e2e-");
    const isolatedHome = await makeTempDir("mate-tokensave-home-");
    const originalRun = tokensaveDeps.run;
    const originalHome = process.env.HOME;
    tokensaveDeps.run = () => ({ ok: true, stderr: "", stdout: "" });
    process.env.HOME = isolatedHome;

    try {
      await applySetupCompatibilities(root, configWith(["tokensave"]), "sync", [
        claudePlugin,
        opencodePlugin,
        tokensavePlugin,
      ]);
    } finally {
      tokensaveDeps.run = originalRun;
      process.env.HOME = originalHome;
    }

    const claudeMcp = await readJson(path.join(root, ".mcp.json"));
    expect(claudeMcp.mcpServers.tokensave).toEqual({
      command: expect.stringContaining("tokensave"),
      args: ["serve"],
    });

    const opencodeConfig = await readJson(path.join(root, ".opencode", "opencode.json"));
    expect(opencodeConfig.mcp.tokensave).toMatchObject({ type: "local", enabled: true });
  });
});

describe("unhosted context services", () => {
  test("warns and continues when no active provider hosts the service", async () => {
    const root = await makeTempDir("mate-unhosted-");
    const bareProvider: Plugin = {
      id: "bare",
      kind: "provider",
      label: "Bare",
      description: "",
      defaultSelected: false,
      isEnabled: (config) => (config.profiles.default?.allowedAgents ?? []).includes("bare"),
      async apply() {},
      async teardown() {},
    };
    const capability = mcpCapability({ name: "acme-kb", command: "acme-kb-mcp" });

    const outcome = await applySetupCompatibilities(
      root,
      {
        ...configWith(["acme-mcp"]),
        profiles: { default: { name: "default", allowedAgents: ["bare"] } },
      },
      "setup",
      [bareProvider, capability],
    );

    expect(outcome.warnings.some((w) => w.includes("no active provider hosts"))).toBe(true);
    // The run continued: the capability's action still executed.
    expect(
      outcome.executedActions.some((a) => a.pluginId === "acme-mcp" && a.action === "apply"),
    ).toBe(true);
  });
});

describe("ctx.mcp.register", () => {
  test("registers the server in every active provider's native config", async () => {
    const root = await makeTempDir("mate-mcp-register-");
    const capability = mcpCapability({
      name: "acme-kb",
      command: "acme-kb-mcp",
      args: ["--serve"],
      env: { ACME_TOKEN: "x" },
    });

    await applySetupCompatibilities(root, configWith(["acme-mcp"]), "setup", [
      claudePlugin,
      opencodePlugin,
      capability,
    ]);

    const claudeMcp = await readJson(path.join(root, ".mcp.json"));
    expect(claudeMcp.mcpServers["acme-kb"]).toEqual({
      command: "acme-kb-mcp",
      args: ["--serve"],
      env: { ACME_TOKEN: "x" },
    });

    const opencodeConfig = await readJson(path.join(root, ".opencode", "opencode.json"));
    expect(opencodeConfig.mcp["acme-kb"]).toEqual({
      type: "local",
      command: ["acme-kb-mcp", "--serve"],
      environment: { ACME_TOKEN: "x" },
      enabled: true,
    });
  });

  test("teardown removes exactly the registered entries, unrelated entries remain", async () => {
    const root = await makeTempDir("mate-mcp-teardown-");
    const capability = mcpCapability({ name: "acme-kb", command: "acme-kb-mcp" });
    const plugins = [claudePlugin, opencodePlugin, capability];

    await applySetupCompatibilities(root, configWith(["acme-mcp"]), "setup", plugins);

    // Simulate a user-managed server next to the managed one.
    const claudeMcpPath = path.join(root, ".mcp.json");
    const claudeMcp = await readJson(claudeMcpPath);
    claudeMcp.mcpServers["user-server"] = { command: "user-mcp" };
    await fs.writeFile(claudeMcpPath, JSON.stringify(claudeMcp, null, 2) + "\n", "utf8");

    await applySetupCompatibilities(root, configWith([]), "setup", plugins);

    const afterClaude = await readJson(claudeMcpPath);
    expect(afterClaude.mcpServers["acme-kb"]).toBeUndefined();
    expect(afterClaude.mcpServers["user-server"]).toEqual({ command: "user-mcp" });

    const afterOpencode = await readJson(path.join(root, ".opencode", "opencode.json"));
    expect(afterOpencode.mcp?.["acme-kb"]).toBeUndefined();
  });
});
