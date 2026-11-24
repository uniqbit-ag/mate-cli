import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { resetActiveDistribution, setActiveDistribution } from "../distribution";
import type { Plugin, PluginCliCommand } from "../tools/setup/plugin";
import { PluginRegistry } from "../tools/setup/registry";
import { ensureCapabilityEnabled, runPluginCliCommand } from "./plugin-commands";

const distributionConfig = {
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

describe("runPluginCliCommand", () => {
  test.each(["--help", "-h"])(
    "%s prints the namespace usage to stdout and runs nothing",
    async (flag) => {
      const originalExitCode = process.exitCode;
      process.exitCode = 0;
      const logs: string[] = [];
      const errors: string[] = [];
      const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logs.push(args.join(" "));
      });
      const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(args.join(" "));
      });
      let ran = false;
      activate(
        makePlugin("acme", [
          {
            name: "list",
            description: "List acme things.",
            run: async () => {
              ran = true;
            },
          },
        ]),
      );

      try {
        expect(await runPluginCliCommand("acme", flag, [])).toBe(true);
        expect(logs.join("\n")).toContain("mate cap acme list  List acme things.");
        expect(errors).toEqual([]);
        expect(ran).toBe(false);
        expect(process.exitCode).toBe(0);
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        process.exitCode = originalExitCode ?? 0;
      }
    },
  );
});

describe("ensureCapabilityEnabled", () => {
  test("returns true without output when the plugin is enabled", async () => {
    const plugin = makePlugin("acme", []);
    plugin.isEnabled = (config) => (config.capabilities ?? []).some((c) => c.name === "acme");
    activate(plugin);

    const enabled = await ensureCapabilityEnabled("acme", {
      loadConfig: async () => ({ allowedAgents: [], capabilities: [{ name: "acme" }] }),
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
        loadConfig: async () => ({ allowedAgents: [], capabilities: [] }),
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
