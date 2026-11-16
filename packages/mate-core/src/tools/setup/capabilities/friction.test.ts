import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { CapabilityContributionInput, SetupContext } from "../plugin";
import { reconcileClaudeContributions } from "../providers/claude";
import { reconcileOpenCodeContributions } from "../providers/opencode";
import { createFrictionPlugin, FRICTION_GUIDANCE } from "./friction";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function companionWith(provider: "claude" | "opencode"): Promise<SetupContext> {
  const companionPath = await fs.mkdtemp(path.join(os.tmpdir(), "mate-friction-plugin-"));
  tempRoots.push(companionPath);
  return {
    companionPath,
    config: { allowedAgents: [provider], capabilities: [] },
    mode: "setup",
    activeProviders: [provider],
  };
}

function input(enabled: boolean, runtime: "claude" | "opencode"): CapabilityContributionInput {
  const contributions = createFrictionPlugin().getRuntimeContributions!({} as never) as Record<
    string,
    object
  >;
  return { pluginId: "friction", enabled, contributions: contributions[runtime] };
}

const read = (file: string) => fs.readFile(file, "utf8").catch(() => "");

describe("the friction capability's runtime contributions", () => {
  test("Claude gets the guidance and the permission entry, and loses both when deselected", async () => {
    const ctx = await companionWith("claude");
    const settings = path.join(ctx.companionPath, ".claude", "settings.local.json");
    const claudeMd = path.join(ctx.companionPath, "CLAUDE.md");

    await reconcileClaudeContributions(ctx, [input(true, "claude")]);
    expect(await read(claudeMd)).toContain("## Friction");
    expect(JSON.parse(await read(settings)).permissions.allow).toContain(
      "Bash(mate cap friction:*)",
    );

    await reconcileClaudeContributions(ctx, [input(false, "claude")]);
    expect(await read(claudeMd)).not.toContain("## Friction");
    expect(await read(settings)).not.toContain("cap friction");
  });

  test("OpenCode gets the guidance only, and loses it when deselected", async () => {
    const ctx = await companionWith("opencode");
    const agentsMd = path.join(ctx.companionPath, "AGENTS.md");

    expect(input(true, "opencode").contributions).not.toHaveProperty("permissionEntries");
    await reconcileOpenCodeContributions(ctx, [input(true, "opencode")]);
    expect(await read(agentsMd)).toContain("## Friction");

    await reconcileOpenCodeContributions(ctx, [input(false, "opencode")]);
    expect(await read(agentsMd)).not.toContain("## Friction");
  });

  test("the guidance has at most 80 words and names the report command", () => {
    expect(FRICTION_GUIDANCE.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(80);
    expect(FRICTION_GUIDANCE).toContain("mate cap friction report");
  });
});
