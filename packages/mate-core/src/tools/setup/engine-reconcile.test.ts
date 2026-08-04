import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

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
  await executeSetupInstallationPlan(ctx, plugins, plan);
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
    ) as { mcp: Record<string, unknown> };
    expect(opencodeConfig.mcp.acme).toEqual({
      type: "local",
      command: ["acme", "serve"],
      enabled: true,
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
});
