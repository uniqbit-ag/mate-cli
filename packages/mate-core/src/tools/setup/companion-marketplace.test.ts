import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  CompanionMarketplaceError,
  generateCompanionMarketplace,
  getCompanionMarketplaceManifestPath,
  getCompanionPluginHooksPath,
  getCompanionPluginManifestPath,
} from "./companion-marketplace";
import { COMPANION_MARKETPLACE_NAME, COMPANION_PLUGIN_NAME } from "./providers/claude";

const tempRoots: string[] = [];

async function makeCompanion(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeSkill(companionPath: string, name: string): Promise<void> {
  const skillDir = path.join(companionPath, ".claude", "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\ndescription: ${name}\n---\n`, "utf8");
}

async function writeMcpConfig(companionPath: string, servers: Record<string, unknown>) {
  await fs.writeFile(
    path.join(companionPath, ".mcp.json"),
    JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
    "utf8",
  );
}

async function writeCompanionSettings(companionPath: string, settings: unknown): Promise<void> {
  const settingsPath = path.join(companionPath, ".claude", "settings.local.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

describe("generateCompanionMarketplace", () => {
  test("generates the scaffold from authored skills without MCP wiring", async () => {
    const companionPath = await makeCompanion("mate-marketplace-basic-");
    await writeSkill(companionPath, "code-review");
    await writeMcpConfig(companionPath, {
      tokensave: { command: "tokensave", args: ["serve"] },
    });

    await generateCompanionMarketplace(companionPath);

    const marketplace = await readJson(getCompanionMarketplaceManifestPath(companionPath));
    expect(marketplace.name).toBe(COMPANION_MARKETPLACE_NAME);
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: COMPANION_PLUGIN_NAME, source: "./" }),
    ]);

    const plugin = await readJson(getCompanionPluginManifestPath(companionPath));
    expect(plugin.name).toBe(COMPANION_PLUGIN_NAME);
    expect(plugin.skills).toEqual(["./.claude/skills/"]);
    /* companion MCP servers are delivered through the Mate MCP gateway */
    expect(plugin.mcpServers).toBeUndefined();
    expect(plugin.commands).toBeUndefined();
    expect(plugin.agents).toBeUndefined();
    expect(plugin.hooks).toBeUndefined();
  });

  test("rewrites companion-path hook wiring to plugin-root-relative hooks.json", async () => {
    const companionPath = await makeCompanion("mate-marketplace-hooks-");
    const hookScript = path.join(companionPath, ".claude", "hooks", "react-doctor.sh");
    await fs.mkdir(path.dirname(hookScript), { recursive: true });
    await fs.writeFile(hookScript, "#!/bin/sh\nexit 0\n", "utf8");
    await writeCompanionSettings(companionPath, {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: hookScript }],
          },
        ],
      },
    });

    await generateCompanionMarketplace(companionPath);

    const plugin = await readJson(getCompanionPluginManifestPath(companionPath));
    expect(plugin.hooks).toBe("./.claude-plugin/hooks.json");
    const hooks = await readJson(getCompanionPluginHooksPath(companionPath));
    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toBe(
      "${CLAUDE_PLUGIN_ROOT}/.claude/hooks/react-doctor.sh",
    );
  });

  test("regeneration reflects authored additions and removals; generated output is not source of truth", async () => {
    const companionPath = await makeCompanion("mate-marketplace-regen-");
    await writeSkill(companionPath, "first");
    await generateCompanionMarketplace(companionPath);

    // Hand-edits to the generated output must not survive regeneration.
    await fs.writeFile(
      getCompanionMarketplaceManifestPath(companionPath),
      JSON.stringify({ name: "hand-edited" }),
      "utf8",
    );

    // Authored additions: agents appear...
    const agentsDir = path.join(companionPath, ".claude", "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(path.join(agentsDir, "reviewer.md"), "# reviewer\n", "utf8");
    // ...and removals: skills disappear.
    await fs.rm(path.join(companionPath, ".claude", "skills"), { recursive: true, force: true });

    await generateCompanionMarketplace(companionPath);

    const marketplace = await readJson(getCompanionMarketplaceManifestPath(companionPath));
    expect(marketplace.name).toBe(COMPANION_MARKETPLACE_NAME);
    const plugin = await readJson(getCompanionPluginManifestPath(companionPath));
    expect(plugin.agents).toEqual(["./.claude/agents/"]);
    expect(plugin.skills).toBeUndefined();
  });

  test("regeneration is byte-idempotent", async () => {
    const companionPath = await makeCompanion("mate-marketplace-idempotent-");
    await writeSkill(companionPath, "stable");

    await generateCompanionMarketplace(companionPath);
    const first = await fs.readFile(getCompanionPluginManifestPath(companionPath), "utf8");
    await generateCompanionMarketplace(companionPath);
    const second = await fs.readFile(getCompanionPluginManifestPath(companionPath), "utf8");

    expect(second).toBe(first);
  });

  test("fails with repair guidance when a hook references a missing file", async () => {
    const companionPath = await makeCompanion("mate-marketplace-broken-hook-");
    await writeCompanionSettings(companionPath, {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: path.join(companionPath, ".claude", "hooks", "gone.sh"),
              },
            ],
          },
        ],
      },
    });

    await expect(generateCompanionMarketplace(companionPath)).rejects.toThrow(
      CompanionMarketplaceError,
    );
    await expect(generateCompanionMarketplace(companionPath)).rejects.toThrow(
      /gone\.sh.*companion setup/s,
    );
    // A failed validation must not leave a scaffold Claude would try to load.
    await expect(fs.access(getCompanionMarketplaceManifestPath(companionPath))).rejects.toThrow();
  });

  test("MCP entries are not validated and never fail the scaffold (hooks only)", async () => {
    const companionPath = await makeCompanion("mate-marketplace-mcp-ignored-");
    await writeSkill(companionPath, "code-review");
    /* entries that the old validation rejected must no longer matter */
    await writeMcpConfig(companionPath, {
      broken: { command: "./bin/server" },
      missing: { command: path.join(companionPath, "does-not-exist") },
    });

    await generateCompanionMarketplace(companionPath);

    const plugin = await readJson(getCompanionPluginManifestPath(companionPath));
    expect(plugin.mcpServers).toBeUndefined();
  });
});
