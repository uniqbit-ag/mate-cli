import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { getClaudeCapabilityPluginsRoot } from "../../../lib/package-paths";
import { runtimeClaudeCapabilityPluginsRoot } from "../../../runtime/runtime-directory";
import type { SetupContext } from "../plugin";
import { createCompanionMentionsPlugin } from "./companion-mentions";

function makeCtx(
  capabilities: { name: string }[] = [{ name: "companion-mentions" }],
): SetupContext {
  return {
    companionPath: "/tmp/acme-companion",
    activeProviders: ["claude", "opencode"],
    mode: "sync",
    config: { allowedAgents: ["claude", "opencode"], capabilities },
  };
}

describe("createCompanionMentionsPlugin", () => {
  test("is an optional Capability that is not selected by default", () => {
    const plugin = createCompanionMentionsPlugin();
    expect(plugin.id).toBe("companion-mentions");
    expect(plugin.kind).toBe("capability");
    expect(plugin.defaultSelected).toBe(false);
  });

  test("is enabled only while the companion selects it", () => {
    const plugin = createCompanionMentionsPlugin();
    expect(plugin.isEnabled(makeCtx().config)).toBe(true);
    expect(plugin.isEnabled(makeCtx([{ name: "rtk" }]).config)).toBe(false);
  });

  test("contributes the mod through the runtime link, and nothing to OpenCode", async () => {
    const contributions = await createCompanionMentionsPlugin().getRuntimeContributions!(makeCtx());
    expect(contributions).toEqual({
      claude: {
        pluginDirectories: [
          { path: path.join(runtimeClaudeCapabilityPluginsRoot(), "companion-mentions") },
        ],
      },
    });
  });

  test("names a folder that mate-core ships with the mod's manifest", () => {
    const manifest = path.join(
      getClaudeCapabilityPluginsRoot(),
      "companion-mentions",
      ".claude-plugin",
      "plugin.json",
    );
    expect(fs.statSync(manifest).isFile()).toBe(true);
  });
});
