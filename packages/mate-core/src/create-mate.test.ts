import { afterEach, describe, expect, test } from "bun:test";

let mainImpl: (argv?: string[]) => Promise<void> = async () => {};

const { createMate } = await import("./create-mate");
const { getActiveDistribution, resetActiveDistribution } = await import("./distribution");
import type { Plugin } from "./tools/setup/plugin";

function makePlugin(id: string, kind: Plugin["kind"] = "capability"): Plugin {
  return {
    id,
    kind,
    label: id,
    description: "",
    defaultSelected: false,
    isEnabled: () => true,
    async apply() {},
    async teardown() {},
  };
}

const acmeConfig = {
  name: "acme-mate",
  legacyNames: [],
  runtime: "bun",
  version: "1.0.0",
  update: {
    packageName: "@acme/mate",
    registry: "https://npm.acme.test/",
  },
};

afterEach(() => {
  resetActiveDistribution();
});

describe("createMate", () => {
  test("builds the registry from bun, uv, the provided plugin entries, and the built-in gitignore plugin", () => {
    const pluginA = makePlugin("acme-a");
    const pluginB = makePlugin("acme-b");
    const cli = createMate({
      config: acmeConfig,
      plugins: [pluginA, { plugin: pluginB, policy: "required" }],
    });

    const all = cli.registry.getAll();
    expect(all.map((plugin) => plugin.id)).toEqual(["acme-a", "acme-b", "bun", "uv", "gitignore"]);
    expect(cli.registry.getPolicy("bun")).toBe("required");
    expect(cli.registry.getPolicy("uv")).toBe("required");
    expect(cli.registry.getPolicy("acme-b")).toBe("required");
  });

  test("adds only bun, uv, and the built-in gitignore plugin when the plugins list is empty", () => {
    const cli = createMate({ config: acmeConfig, plugins: [] });
    expect(cli.registry.getAll().map((plugin) => plugin.id)).toEqual(["bun", "uv", "gitignore"]);
  });

  test("threads the distribution config and registry to the active distribution", () => {
    const cli = createMate({ config: acmeConfig, plugins: [makePlugin("acme-a")] });

    const active = getActiveDistribution();
    expect(active.config.name).toBe("acme-mate");
    expect(active.config.version).toBe("1.0.0");
    expect(active.config.update).toEqual({
      packageName: "@acme/mate",
      registry: "https://npm.acme.test/",
    });
    expect(active.registry).toBe(cli.registry);
  });

  test("returns a runnable CLI", () => {
    const cli = createMate({ config: acmeConfig, plugins: [] });
    expect(typeof cli.run).toBe("function");
  });

  test("run() catches a rejection from main, reports it, and sets a failing exit code", async () => {
    mainImpl = async () => {
      throw new Error("boom");
    };

    const cli = createMate({ config: acmeConfig, plugins: [], main: (argv) => mainImpl(argv) });
    const errors: unknown[] = [];
    const originalConsoleError = console.error;
    const originalExitCode = process.exitCode;
    console.error = (...args: unknown[]) => errors.push(...args);

    try {
      await expect(cli.run([])).resolves.toBeUndefined();
      expect(errors).toEqual(["boom"]);
      expect(process.exitCode).toBe(1);
    } finally {
      console.error = originalConsoleError;
      process.exitCode = originalExitCode;
    }
  });
});

describe("active distribution fallback", () => {
  test("falls back to the mate distribution defaults when createMate has not run", () => {
    const active = getActiveDistribution();
    expect(active.config.name).toBe("mate");
    const ids = active.registry.getAll().map((plugin) => plugin.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("opencode");
    expect(ids).toContain("gitignore");
  });
});
