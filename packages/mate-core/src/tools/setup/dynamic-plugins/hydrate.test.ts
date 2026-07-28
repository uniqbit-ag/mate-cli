import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PluginRegistry } from "../registry";
import type { Plugin } from "../plugin";
import type { PluginHost } from "./host";
import { hydrateDynamicPlugins, resetDynamicPluginHydration } from "./hydrate";
import { pluginPackageRoot } from "./paths";
import { PluginPinStore } from "./pin-store";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

beforeEach(() => {
  resetDynamicPluginHydration();
});

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const PACKAGE = "@acme/custom-plugin";

const fakeHost: PluginHost = {
  apiVersion: 1,
  distribution: { name: "acme-mate", version: "0.0.1" },
  ensureCapabilityEnabled: async () => true,
};

const FACTORY_SOURCE = `
export default function createPlugin(config, host) {
  return {
    id: "acme-custom",
    kind: "capability",
    label: "Acme Custom",
    description: "test plugin",
    defaultSelected: false,
    isEnabled: (frameworkConfig) =>
      (frameworkConfig.capabilities ?? []).some((capability) => capability.name === "acme-custom"),
    apply: async () => {},
    teardown: async () => {},
    cliCommands: [{ name: "hello", description: "say hello", run: async () => {} }],
  };
}
`;

async function writeCompanion(options: {
  pluginsYaml?: string[];
  installed?: boolean;
  pinned?: boolean;
  source?: string;
}): Promise<string> {
  const companionPath = await makeTempDir("hydrate-companion-");
  const configDir = path.join(companionPath, ".mate", "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "framework.yaml"),
    [
      "profiles:",
      "  default:",
      "    name: default",
      "    allowedAgents: []",
      ...(options.pluginsYaml ?? []),
      "",
    ].join("\n"),
    "utf8",
  );
  if (options.installed !== false) {
    const root = pluginPackageRoot(companionPath, PACKAGE);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: PACKAGE, version: "1.2.0", type: "module", main: "index.js" }),
      "utf8",
    );
    await fs.writeFile(path.join(root, "index.js"), options.source ?? FACTORY_SOURCE, "utf8");
  }
  if (options.pinned !== false) {
    await new PluginPinStore(companionPath).save({
      plugins: [{ package: PACKAGE, declaredVersion: "^1.0.0", resolvedVersion: "1.2.0" }],
    });
  }
  return companionPath;
}

const DECLARED = ["plugins:", `  - package: "${PACKAGE}"`, '    version: "^1.0.0"'];

function makeRegistry(plugins: Plugin[] = []): PluginRegistry {
  return new PluginRegistry(plugins.map((plugin) => ({ plugin, policy: "required" as const })));
}

describe("hydrateDynamicPlugins", () => {
  test("registers a declared plugin with the declared policy default", async () => {
    const companionPath = await writeCompanion({ pluginsYaml: DECLARED });
    const registry = makeRegistry();
    const warnings: string[] = [];

    await hydrateDynamicPlugins({
      companionPath,
      registry,
      host: fakeHost,
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
    expect(registry.getAll().map((plugin) => plugin.id)).toEqual(["acme-custom"]);
    expect(registry.getPolicy("acme-custom")).toBe("optional");
  });

  test("honors an explicit default policy", async () => {
    const companionPath = await writeCompanion({
      pluginsYaml: [...DECLARED, "    policy: default"],
    });
    const registry = makeRegistry();

    await hydrateDynamicPlugins({ companionPath, registry, host: fakeHost, warn: () => {} });

    expect(registry.getPolicy("acme-custom")).toBe("default");
  });

  test("no plugins entries is a silent no-op", async () => {
    const companionPath = await writeCompanion({
      pluginsYaml: [],
      installed: false,
      pinned: false,
    });
    const registry = makeRegistry();
    const warnings: string[] = [];

    await hydrateDynamicPlugins({
      companionPath,
      registry,
      host: fakeHost,
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
    expect(registry.getAll()).toEqual([]);
  });

  test("no companion resolves to a silent no-op", async () => {
    const cwd = await makeTempDir("hydrate-nocompanion-");
    const warnings: string[] = [];

    await hydrateDynamicPlugins({
      cwd,
      env: {},
      registry: makeRegistry(),
      host: fakeHost,
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
  });

  test("declared-but-uninstalled plugin warns and keeps others working", async () => {
    const companionPath = await writeCompanion({
      pluginsYaml: [
        "plugins:",
        '  - package: "@acme/missing"',
        '    version: "1.0.0"',
        `  - package: "${PACKAGE}"`,
        '    version: "^1.0.0"',
      ],
    });
    const registry = makeRegistry();
    const warnings: string[] = [];

    await hydrateDynamicPlugins({
      companionPath,
      registry,
      host: fakeHost,
      warn: (message) => warnings.push(message),
    });

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("@acme/missing");
    expect(warnings[0]).toContain("install");
    expect(registry.getAll().map((plugin) => plugin.id)).toEqual(["acme-custom"]);
  });

  test("required policy in a declaration is refused per-plugin", async () => {
    const companionPath = await writeCompanion({
      pluginsYaml: [...DECLARED, "    policy: required"],
    });
    const registry = makeRegistry();
    const warnings: string[] = [];

    await hydrateDynamicPlugins({
      companionPath,
      registry,
      host: fakeHost,
      warn: (message) => warnings.push(message),
    });

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("required");
    expect(registry.getAll()).toEqual([]);
  });

  test("cap namespace collision warns deterministically and first registration wins", async () => {
    const companionPath = await writeCompanion({ pluginsYaml: DECLARED });
    const builtin: Plugin = {
      id: "acme-custom",
      kind: "capability",
      label: "Built-in",
      description: "compiled-in plugin owning the namespace",
      defaultSelected: false,
      isEnabled: () => true,
      apply: async () => {},
      teardown: async () => {},
      cliCommands: [{ name: "hello", description: "built-in hello", run: async () => {} }],
    };
    const registry = makeRegistry([builtin]);
    const warnings: string[] = [];

    await hydrateDynamicPlugins({
      companionPath,
      registry,
      host: fakeHost,
      warn: (message) => warnings.push(message),
    });

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("acme-custom");
    expect(warnings[0]).toContain(PACKAGE);
    expect(warnings[0]).toContain("first registration wins");
    // Both stay registered; routing picks the first.
    expect(registry.getAll()[0]).toBe(builtin);
  });

  test("re-hydration in the same process does not double-register", async () => {
    const companionPath = await writeCompanion({ pluginsYaml: DECLARED });
    const registry = makeRegistry();

    await hydrateDynamicPlugins({ companionPath, registry, host: fakeHost, warn: () => {} });
    await hydrateDynamicPlugins({ companionPath, registry, host: fakeHost, warn: () => {} });

    expect(registry.getAll().length).toBe(1);
  });

  test("hydration never throws even when resolution explodes", async () => {
    const warnings: string[] = [];
    await hydrateDynamicPlugins({
      companionPath: "\0invalid",
      registry: makeRegistry(),
      host: fakeHost,
      warn: (message) => warnings.push(message),
    });
    expect(warnings.length).toBeLessThanOrEqual(1);
  });
});
