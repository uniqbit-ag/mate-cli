import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { FrameworkConfig } from "../../../lib/orchestrator/types";
import type { McpManagerConfig } from "../../../lib/mcp-manager/types";
import { applySetupCompatibilities } from "../../setup";
import type { CapabilityPlugin } from "../plugin";
import { createClaudePlugin } from "../providers/claude";
import { createOpenCodePlugin } from "../providers/opencode";
import { createMcpManagerPlugin } from "./mcp-manager";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeCompanion(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-mcp-manager-"));
  tempRoots.push(dir);
  return dir;
}

async function readJson(filePath: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

/** A Capability registering `name` imperatively, the way Context7 does. */
function registeringCapability(name: string): CapabilityPlugin {
  return {
    id: name,
    kind: "capability",
    label: name,
    description: "",
    defaultSelected: false,
    isEnabled: (config) => (config.capabilities ?? []).some((entry) => entry.name === name),
    async apply(ctx) {
      await ctx.mcp?.register({ name, command: `${name}-mcp` });
    },
    async teardown() {},
  };
}

/** A Capability declaring `name` as a contribution, the way TokenSave does. */
function declaringCapability(name: string): CapabilityPlugin {
  const mcpServers = [{ name, command: `${name}-mcp` }];
  return {
    ...registeringCapability(name),
    async apply() {},
    getRuntimeContributions: () => ({ claude: { mcpServers }, opencode: { mcpServers } }),
  };
}

const docs = { command: "npx", args: ["-y", "acme-docs-mcp"], env: ["ACME_TOKEN"] };

function config(mcpManager?: McpManagerConfig, capabilities: string[] = []): FrameworkConfig {
  return {
    allowedAgents: ["claude", "opencode"],
    capabilities: capabilities.map((name) => ({ name })),
    ...(mcpManager ? { mcpManager } : {}),
  };
}

async function sync(root: string, framework: FrameworkConfig, extra: CapabilityPlugin[] = []) {
  return applySetupCompatibilities(root, framework, "sync", [
    createClaudePlugin(),
    createOpenCodePlugin(),
    createMcpManagerPlugin({}),
    ...extra,
  ]);
}

async function serverNames(root: string): Promise<{ claude: string[]; opencode: string[] }> {
  const claude = await readJson(path.join(root, ".mcp.json"));
  const opencode = await readJson(path.join(root, ".opencode", "opencode.json"));
  return {
    claude: Object.keys(claude.mcpServers ?? {}).toSorted(),
    opencode: Object.keys(opencode.mcp?.servers ?? {}).toSorted(),
  };
}

describe("mcp-manager Capability", () => {
  test("renders a declared server for Claude and OpenCode as references, never a value", async () => {
    const root = await makeCompanion();
    process.env.ACME_TOKEN = "s3cr3t";
    try {
      await sync(
        root,
        config({ servers: { "acme-docs": docs }, enabled: { servers: ["acme-docs"] } }),
      );
    } finally {
      delete process.env.ACME_TOKEN;
    }

    const claude = await fs.readFile(path.join(root, ".mcp.json"), "utf8");
    const opencode = await fs.readFile(path.join(root, ".opencode", "opencode.json"), "utf8");
    expect(JSON.parse(claude).mcpServers["acme-docs"]).toEqual({
      command: "npx",
      args: ["-y", "acme-docs-mcp"],
      env: { ACME_TOKEN: "${ACME_TOKEN}" },
    });
    expect(JSON.parse(opencode).mcp.servers["acme-docs"]).toEqual({
      type: "local",
      command: ["npx", "-y", "acme-docs-mcp"],
      environment: { ACME_TOKEN: "{env:ACME_TOKEN}" },
      disabled: false,
    });
    expect(claude + opencode).not.toContain("s3cr3t");
  });

  test("a deleted server and then the removed section are torn down; other entries stay", async () => {
    const root = await makeCompanion();
    const acme = registeringCapability("acme-kb");
    await sync(
      root,
      config(
        {
          servers: { "acme-docs": docs, "acme-db": { command: "acme-db-mcp" } },
          enabled: { servers: ["acme-docs", "acme-db"] },
        },
        ["acme-kb"],
      ),
      [acme],
    );
    const mcpPath = path.join(root, ".mcp.json");
    const withUser = await readJson(mcpPath);
    withUser.mcpServers["user-server"] = { command: "user-mcp" };
    await fs.writeFile(mcpPath, JSON.stringify(withUser), "utf8");

    await sync(
      root,
      config(
        { servers: { "acme-db": { command: "acme-db-mcp" } }, enabled: { servers: ["acme-db"] } },
        ["acme-kb"],
      ),
      [acme],
    );
    expect(await serverNames(root)).toEqual({
      claude: ["acme-db", "acme-kb", "user-server"],
      opencode: ["acme-db", "acme-kb"],
    });

    await sync(root, config(undefined, ["acme-kb"]), [acme]);
    expect(await serverNames(root)).toEqual({
      claude: ["acme-kb", "user-server"],
      opencode: ["acme-kb"],
    });
  });

  for (const [kind, capability] of [
    ["registers", registeringCapability("context7")],
    ["declares", declaringCapability("context7")],
  ] as const) {
    test(`a server named like one another Capability ${kind} renders nothing and names both`, async () => {
      const root = await makeCompanion();
      const framework = config(
        {
          servers: { context7: { command: "other-mcp" }, "acme-docs": docs },
          enabled: { servers: ["context7", "acme-docs"] },
        },
        ["context7"],
      );

      const outcome = await sync(root, framework, [capability]);

      expect(outcome.warnings.join("\n")).toContain(
        'mcpManager declares MCP server "context7" (also registered by the "context7" Capability)',
      );
      const claude = await readJson(path.join(root, ".mcp.json"));
      expect(claude.mcpServers).toEqual({ context7: { command: "context7-mcp" } });
    });
  }

  test("a clashing catalog server refuses the set even when it is not selected", async () => {
    const root = await makeCompanion();
    const catalog = {
      servers: { context7: { command: "other-mcp" }, "acme-docs": docs },
      enabled: { servers: ["acme-docs"] },
    };
    const outcome = await sync(root, config(catalog, ["context7"]), [
      registeringCapability("context7"),
    ]);

    expect(outcome.warnings.join("\n")).toContain('mcpManager declares MCP server "context7"');
    expect(await serverNames(root)).toEqual({ claude: ["context7"], opencode: ["context7"] });
  });

  test("a remote server without a transport renders as http for Claude", async () => {
    const root = await makeCompanion();
    await sync(
      root,
      config({
        servers: { "acme-api": { url: "https://mcp.acme.example" } },
        enabled: { servers: ["acme-api"] },
      }),
    );
    const claude = await readJson(path.join(root, ".mcp.json"));
    expect(claude.mcpServers["acme-api"]).toEqual({
      type: "http",
      url: "https://mcp.acme.example",
    });
  });

  test("a disabled Capability's teardown keeps a server of the same name", async () => {
    const root = await makeCompanion();
    const catalog = { servers: { context7: docs }, enabled: { servers: ["context7"] } };
    await sync(root, config(catalog), [declaringCapability("context7")]);

    expect(await serverNames(root)).toEqual({ claude: ["context7"], opencode: ["context7"] });
  });

  test("a clash keeps the servers a previous sync rendered", async () => {
    const root = await makeCompanion();
    const context7 = registeringCapability("context7");
    const catalog = {
      servers: { context7: { command: "other-mcp" }, "acme-docs": docs },
      enabled: { servers: ["context7", "acme-docs"] },
    };
    await sync(root, config(catalog), [context7]);

    await sync(root, config(catalog, ["context7"]), [context7]);

    const claude = await readJson(path.join(root, ".mcp.json"));
    expect(Object.keys(claude.mcpServers).toSorted()).toEqual(["acme-docs", "context7"]);
    expect(claude.mcpServers.context7).toEqual({ command: "context7-mcp" });

    const renamed = {
      servers: { "acme-other": { command: "other-mcp" }, "acme-docs": docs },
      enabled: { servers: ["acme-other", "acme-docs"] },
    };
    await sync(root, config(renamed, ["context7"]), [context7]);

    const fixed = await readJson(path.join(root, ".mcp.json"));
    expect(Object.keys(fixed.mcpServers).toSorted()).toEqual([
      "acme-docs",
      "acme-other",
      "context7",
    ]);
    expect(fixed.mcpServers.context7).toEqual({ command: "context7-mcp" });
  });
});
