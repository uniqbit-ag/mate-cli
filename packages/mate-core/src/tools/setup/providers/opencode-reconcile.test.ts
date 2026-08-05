import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { CapabilityContributionInput, SetupContext } from "../plugin";
import {
  reconcileOpenCodeContributions,
  removeOpenCodeForeignPluginReferences,
  stripOpenCodeForeignSections,
} from "./opencode";

const tempRoots: string[] = [];

async function makeCompanion(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-reconcile-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeCtx(companionPath: string, activeProviders: string[]): SetupContext {
  return {
    companionPath,
    config: { allowedAgents: activeProviders, capabilities: [] },
    mode: "setup",
    activeProviders,
  };
}

function contribution(enabled: boolean, companionPath: string): CapabilityContributionInput {
  return {
    pluginId: "acme",
    enabled,
    contributions: {
      mcpServers: [{ name: "acme", command: "acme", args: ["serve"] }],
      pluginReferences: [
        {
          reference: "acme-plugin@2.0.0",
          isManagedReference: (entry) =>
            typeof entry === "string" && entry.startsWith("acme-plugin"),
        },
      ],
      guidanceSections: [{ content: "## Acme\n\nUse the acme tools." }],
      skillTrees: [{ name: "acme", sourceDir: path.join(companionPath, "skill-src") }],
      agentDefinitions: [{ name: "acme-agent", content: "---\nmode: primary\n---\nAcme agent.\n" }],
    },
  };
}

async function seedSkillSource(companionPath: string): Promise<void> {
  const src = path.join(companionPath, "skill-src");
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, "SKILL.md"), "acme skill\n", "utf8");
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

describe("reconcileOpenCodeContributions", () => {
  test("enabled contributions land in opencode configs, guidance, and skills", async () => {
    const companionPath = await makeCompanion();
    await seedSkillSource(companionPath);
    // A stale managed pin must be replaced; user plugins must survive.
    const configPath = path.join(companionPath, ".opencode", "opencode.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ plugin: ["user-plugin", "acme-plugin@1.0.0"] }),
      "utf8",
    );

    await reconcileOpenCodeContributions(makeCtx(companionPath, ["opencode"]), [
      contribution(true, companionPath),
    ]);

    const config = await readJson(configPath);
    expect(config.plugin).toEqual(["user-plugin", "acme-plugin@2.0.0"]);
    expect((config.mcp as Record<string, unknown>).acme).toEqual({
      type: "local",
      command: ["acme", "serve"],
      enabled: true,
    });

    const tui = await readJson(path.join(companionPath, ".opencode", "tui.json"));
    expect(tui.plugin).toEqual(["acme-plugin@2.0.0"]);

    const agentsMd = await fs.readFile(path.join(companionPath, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("## Acme");

    await fs.access(path.join(companionPath, ".opencode", "skills", "acme", "SKILL.md"));

    expect(
      await fs.readFile(path.join(companionPath, ".opencode", "agents", "acme-agent.md"), "utf8"),
    ).toBe("---\nmode: primary\n---\nAcme agent.\n");
  });

  test("disabling removes managed entries and is idempotent", async () => {
    const companionPath = await makeCompanion();
    await seedSkillSource(companionPath);
    const ctx = makeCtx(companionPath, ["opencode"]);

    await reconcileOpenCodeContributions(ctx, [contribution(true, companionPath)]);
    await reconcileOpenCodeContributions(ctx, [contribution(true, companionPath)]);
    const configPath = path.join(companionPath, ".opencode", "opencode.json");
    const config = await readJson(configPath);
    expect(config.plugin).toEqual(["acme-plugin@2.0.0"]);

    await reconcileOpenCodeContributions(ctx, [contribution(false, companionPath)]);

    const after = await readJson(configPath);
    expect(after.plugin).toBeUndefined();
    expect(after.mcp).toBeUndefined();
    await expect(fs.access(path.join(companionPath, "AGENTS.md"))).rejects.toThrow();
    await expect(
      fs.access(path.join(companionPath, ".opencode", "skills", "acme")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(companionPath, ".opencode", "agents", "acme-agent.md")),
    ).rejects.toThrow();
  });

  // Capability teardown strips the section even from a shared file — the
  // shared-file guard protects runtime teardown (provider teardown paths keep
  // AGENTS.md while another active runtime uses it), not capability disable.
  test("disabling the capability strips its section while other file content survives", async () => {
    const companionPath = await makeCompanion();
    await seedSkillSource(companionPath);
    const ctx = makeCtx(companionPath, ["claude", "opencode"]);
    await fs.writeFile(path.join(companionPath, "AGENTS.md"), "# Shared notes\n", "utf8");

    await reconcileOpenCodeContributions(ctx, [contribution(true, companionPath)]);
    await reconcileOpenCodeContributions(ctx, [contribution(false, companionPath)]);

    const agentsMd = await fs.readFile(path.join(companionPath, "AGENTS.md"), "utf8");
    expect(agentsMd).not.toContain("## Acme");
    expect(agentsMd).toContain("# Shared notes");
  });
});

describe("opencode escape hatch", () => {
  const isAcmeHeading = (line: string) => /^##\s+acme\s*$/.test(line);

  test("stripOpenCodeForeignSections honors the shared-file guard on AGENTS.md", async () => {
    const companionPath = await makeCompanion();
    const section = "# Keep\n\n## acme\n\nForeign body.\n";
    await fs.writeFile(path.join(companionPath, "AGENTS.md"), section, "utf8");

    await stripOpenCodeForeignSections(companionPath, {
      isHeading: isAcmeHeading,
      guardSharedFile: { activeProviders: ["claude", "opencode"] },
    });
    expect(await fs.readFile(path.join(companionPath, "AGENTS.md"), "utf8")).toBe(section);

    await stripOpenCodeForeignSections(companionPath, {
      isHeading: isAcmeHeading,
      guardSharedFile: { activeProviders: ["opencode"] },
    });
    expect(await fs.readFile(path.join(companionPath, "AGENTS.md"), "utf8")).toBe("# Keep\n");
  });

  test("removeOpenCodeForeignPluginReferences filters entries and deletes emptied configs", async () => {
    const companionPath = await makeCompanion();
    const configPath = path.join(companionPath, ".opencode", "opencode.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ plugin: [".opencode/plugins/acme.js", "user-plugin"] }),
      "utf8",
    );

    await removeOpenCodeForeignPluginReferences(companionPath, (entry) =>
      String(entry).includes("acme"),
    );
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      plugin: ["user-plugin"],
    });

    await fs.writeFile(
      configPath,
      JSON.stringify({ plugin: [".opencode/plugins/acme.js"] }),
      "utf8",
    );
    await removeOpenCodeForeignPluginReferences(companionPath, (entry) =>
      String(entry).includes("acme"),
    );
    await expect(fs.access(configPath)).rejects.toThrow();
  });
});
