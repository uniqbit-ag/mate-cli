import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { resetActiveDistribution, setActiveDistribution } from "../distribution";
import type { Plugin, PluginCliCommand } from "../tools/setup/plugin";
import { PluginRegistry } from "../tools/setup/registry";
import { ensureCapabilityEnabled } from "./plugin-commands";

const distributionConfig = {
  name: "acme-mate",
  runtime: "bun" as const,
  version: "1.0.0",
};

function makePlugin(id: string, cliCommands?: PluginCliCommand[]): Plugin {
  return {
    id,
    kind: "capability",
    label: id,
    description: "",
    defaultSelected: false,
    isEnabled: () => true,
    async apply() {},
    async teardown() {},
    cliCommands,
  };
}

function activate(...plugins: Plugin[]): void {
  setActiveDistribution({
    config: distributionConfig,
    registry: new PluginRegistry(plugins),
  });
}

afterEach(() => {
  resetActiveDistribution();
});

describe("ensureCapabilityEnabled", () => {
  test("returns true without output when the plugin is enabled", async () => {
    const plugin = makePlugin("acme", []);
    plugin.isEnabled = (config) => (config.capabilities ?? []).some((c) => c.name === "acme");
    activate(plugin);

    const enabled = await ensureCapabilityEnabled("acme", {
      loadConfig: async () => ({ profiles: {}, capabilities: [{ name: "acme" }] }),
    });

    expect(enabled).toBe(true);
  });

  test("fails with a message naming the plugin and how to enable it when disabled", async () => {
    const originalExitCode = process.exitCode;
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    const plugin = makePlugin("acme", []);
    plugin.isEnabled = (config) => (config.capabilities ?? []).some((c) => c.name === "acme");
    activate(plugin);

    try {
      const enabled = await ensureCapabilityEnabled("acme", {
        loadConfig: async () => ({ profiles: {}, capabilities: [] }),
      });

      expect(enabled).toBe(false);
      expect(errors[0]).toContain('"acme" capability is not enabled');
      expect(errors[0]).toContain("companion setup");
      expect(process.exitCode).toBe(1);
    } finally {
      errorSpy.mockRestore();
      process.exitCode = originalExitCode ?? 0;
    }
  });
});
