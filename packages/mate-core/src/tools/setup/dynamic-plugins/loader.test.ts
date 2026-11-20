import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import type { PluginHost } from "./host";
import { loadDynamicPlugin } from "./loader";
import { pluginPackageRoot } from "./paths";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const PACKAGE = "@acme/custom-plugin";

const FACTORY_SOURCE = `
export default function createPlugin(config, host) {
  if (config && config.reject) throw new Error("companions must be a non-empty list");
  return {
    id: "acme-custom",
    kind: "capability",
    label: "Acme Custom",
    description: "test plugin",
    defaultSelected: false,
    isEnabled: (frameworkConfig) =>
      (frameworkConfig.capabilities ?? []).some((capability) => capability.name === "acme-custom"),
    lifecycle: { companion: { apply: async () => {}, teardown: async () => {} } },
    cliCommands: [
      { name: "hello", description: "say hello", run: async () => {} },
    ],
    receivedConfig: config,
    receivedHost: host,
  };
}
`;

interface FixtureOptions {
  version?: string;
  manifestExtra?: Record<string, unknown>;
  source?: string;
  entryField?: Record<string, unknown>;
}

async function writeInstalledPlugin(
  companionPath: string,
  options: FixtureOptions = {},
): Promise<void> {
  const root = pluginPackageRoot(companionPath, PACKAGE);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: PACKAGE,
      version: options.version ?? "1.2.0",
      type: "module",
      ...(options.entryField ?? { main: "index.js" }),
      ...(options.manifestExtra ?? { mate: { pluginApiVersion: 2 } }),
    }),
    "utf8",
  );
  await fs.writeFile(path.join(root, "index.js"), options.source ?? FACTORY_SOURCE, "utf8");
}

const declaration = (overrides: Partial<PluginDeclaration> = {}): PluginDeclaration => ({
  package: PACKAGE,
  version: "^1.0.0",
  ...overrides,
});

const fakeHost: PluginHost = {
  apiVersion: 2,
  distribution: { name: "acme-mate", version: "0.0.1" },
  ensureCapabilityEnabled: async () => true,
};

describe("loadDynamicPlugin", () => {
  test("loads a default-exported factory with effective config and host", async () => {
    const companionPath = await makeTempDir("plugin-load-ok-");
    await writeInstalledPlugin(companionPath);

    const result = await loadDynamicPlugin(
      companionPath,
      declaration({ config: { token: "${ACME_TOKEN}" } }),
      { host: fakeHost, env: { ACME_TOKEN: "secret" } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.id).toBe("acme-custom");
    expect((result.plugin as { receivedConfig?: unknown }).receivedConfig).toEqual({
      token: "secret",
    });
    expect((result.plugin as { receivedHost?: unknown }).receivedHost).toBe(fakeHost);
  });

  test("accepts a named createPlugin export when no default function exists", async () => {
    const companionPath = await makeTempDir("plugin-load-named-");
    await writeInstalledPlugin(companionPath, {
      source: `export function createPlugin() { return { id: "acme-custom", kind: "capability", label: "x", description: "x", defaultSelected: false, isEnabled: () => false, lifecycle: { companion: { apply: async () => {}, teardown: async () => {} } } }; }`,
    });

    const result = await loadDynamicPlugin(companionPath, declaration(), { host: fakeHost });
    expect(result.ok).toBe(true);
  });

  test("uninstalled package warns and points at install", async () => {
    const companionPath = await makeTempDir("plugin-load-uninstalled-");
    const result = await loadDynamicPlugin(companionPath, declaration(), { host: fakeHost });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.warning).toContain(PACKAGE);
    expect(result.warning).toContain("not installed");
  });

  test("unsupported plugin API version is refused before import", async () => {
    const companionPath = await makeTempDir("plugin-load-apiversion-");
    await writeInstalledPlugin(companionPath, {
      manifestExtra: { mate: { pluginApiVersion: 99 } },
      source: `throw new Error("must never execute");`,
    });

    const result = await loadDynamicPlugin(companionPath, declaration(), { host: fakeHost });
    if (result.ok) throw new Error("expected refusal");
    expect(result.warning).toContain("99");
    expect(result.warning).toContain("supports: 1, 2");
  });

  test("a non-number API version is refused before import", async () => {
    const companionPath = await makeTempDir("plugin-load-apinan-");
    await writeInstalledPlugin(companionPath, {
      manifestExtra: { mate: { pluginApiVersion: "2" } },
      source: `throw new Error("must never execute");`,
    });

    const result = await loadDynamicPlugin(companionPath, declaration(), { host: fakeHost });
    if (result.ok) throw new Error("expected refusal");
    expect(result.warning).toBe(
      `plugin "${PACKAGE}" declares an invalid mate.pluginApiVersion ("2"); expected a number, this CLI supports: 1, 2.`,
    );
  });

  test("an undeclared API version loads as deprecated v1 with its handlers mapped onto lifecycle", async () => {
    const companionPath = await makeTempDir("plugin-load-apiv1-");
    await writeInstalledPlugin(companionPath, {
      manifestExtra: {},
      source: `export default () => ({ id: "acme-custom", kind: "capability", label: "x", description: "x", defaultSelected: false, isEnabled: () => false,
        calls: [],
        async apply() { this.calls.push("apply"); }, async teardown() { this.calls.push("teardown"); },
        async applyHub() { this.calls.push("applyHub"); } });`,
    });

    const result = await loadDynamicPlugin(companionPath, declaration(), { host: fakeHost });
    if (!result.ok) throw new Error(result.warning);
    expect(result.warnings).toEqual([]);
    expect(result.deprecation).toContain("deprecated plugin API version 1");
    const { companion, hub } = result.plugin.lifecycle;
    const ctx = {} as Parameters<NonNullable<typeof companion>["apply"]>[0];
    await companion?.apply(ctx);
    await companion?.teardown(ctx);
    await hub?.apply(ctx);
    await hub?.teardown(ctx);
    expect((result.plugin as { calls?: string[] }).calls).toEqual([
      "apply",
      "teardown",
      "applyHub",
    ]);
  });

  const pluginSource = (members: string) =>
    `export default () => ({ id: "acme-custom", kind: "capability", label: "x", description: "x", defaultSelected: false, isEnabled: () => false, ${members} });`;

  for (const [label, members, reason] of [
    [
      "without a lifecycle record",
      "apply: async () => {}, teardown: async () => {}",
      "missing lifecycle record",
    ],
    [
      "with a declared scope that lacks teardown",
      "lifecycle: { hub: { apply: async () => {} } }",
      "lifecycle.hub needs apply and teardown functions",
    ],
    ["whose lifecycle getter throws", `get lifecycle() { throw new Error("boom"); }`, "boom"],
  ] as const) {
    test(`v2 plugin ${label} is refused`, async () => {
      const companionPath = await makeTempDir("plugin-load-badlifecycle-");
      await writeInstalledPlugin(companionPath, { source: pluginSource(members) });

      const result = await loadDynamicPlugin(companionPath, declaration(), { host: fakeHost });
      if (result.ok) throw new Error("expected refusal");
      expect(result.warning).toContain(PACKAGE);
      expect(result.warning).toContain(reason);
    });
  }

  test("half-migrated v2 plugin loads with a warning per leftover", async () => {
    const companionPath = await makeTempDir("plugin-load-halfmigrated-");
    await writeInstalledPlugin(companionPath, {
      source: pluginSource("lifecycle: { companian: {} }, applyHub: async () => {}"),
    });

    const result = await loadDynamicPlugin(companionPath, declaration(), { host: fakeHost });
    if (!result.ok) throw new Error(result.warning);
    expect(result.warnings).toEqual([
      `plugin "${PACKAGE}" declares unknown lifecycle scope "companian"; known scopes: companion, hub.`,
      `plugin "${PACKAGE}" declares applyHub, which plugin API version 2 ignores; move the handlers into lifecycle.`,
    ]);
  });

  test("import errors are isolated into a warning", async () => {
    const companionPath = await makeTempDir("plugin-load-importerror-");
    await writeInstalledPlugin(companionPath, { source: `throw new Error("boom at import");` });
    const result = await loadDynamicPlugin(companionPath, declaration(), { host: fakeHost });
    if (result.ok) throw new Error("expected refusal");
    expect(result.warning).toContain("boom at import");
  });

  test("entry point without a factory export is an invalid plugin", async () => {
    const companionPath = await makeTempDir("plugin-load-nofactory-");
    await writeInstalledPlugin(companionPath, { source: `export const nothing = 1;` });
    const result = await loadDynamicPlugin(companionPath, declaration(), { host: fakeHost });
    if (result.ok) throw new Error("expected refusal");
    expect(result.warning).toContain("createPlugin");
  });

  test("unset interpolation variable skips the plugin naming the variable", async () => {
    const companionPath = await makeTempDir("plugin-load-envmissing-");
    await writeInstalledPlugin(companionPath);
    const result = await loadDynamicPlugin(
      companionPath,
      declaration({ config: { token: "${ACME_TOKEN}" } }),
      { host: fakeHost, env: {} },
    );
    if (result.ok) throw new Error("expected refusal");
    expect(result.warning).toContain("ACME_TOKEN");
  });

  test("throwing factory is reported as a configuration rejection", async () => {
    const companionPath = await makeTempDir("plugin-load-reject-");
    await writeInstalledPlugin(companionPath);
    const result = await loadDynamicPlugin(
      companionPath,
      declaration({ config: { reject: true } }),
      {
        host: fakeHost,
      },
    );
    if (result.ok) throw new Error("expected refusal");
    expect(result.warning).toContain("rejected its configuration");
    expect(result.warning).toContain("companions must be a non-empty list");
  });

  test("resolves the entry point via real module resolution from an exports map", async () => {
    const companionPath = await makeTempDir("plugin-load-exports-");
    await writeInstalledPlugin(companionPath, {
      entryField: {
        exports: { ".": { types: "./index.d.ts", require: "./index.js", import: "./index.js" } },
      },
    });
    const result = await loadDynamicPlugin(companionPath, declaration(), { host: fakeHost });
    expect(result.ok).toBe(true);
  });

  test("entry point that cannot be resolved by the package manager's resolver is refused", async () => {
    const companionPath = await makeTempDir("plugin-load-badentry-");
    // No fallback index.js in the package directory, and `main` points nowhere
    // — resolution must fail rather than silently picking something else up.
    const root = pluginPackageRoot(companionPath, PACKAGE);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: PACKAGE,
        version: "1.2.0",
        type: "module",
        main: "does-not-exist.js",
        mate: { pluginApiVersion: 2 },
      }),
      "utf8",
    );
    const result = await loadDynamicPlugin(companionPath, declaration(), { host: fakeHost });
    if (result.ok) throw new Error("expected refusal");
    expect(result.warning).toContain("could not be resolved");
  });
});
