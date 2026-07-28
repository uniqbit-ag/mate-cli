import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import type { PluginHost } from "./host";
import { loadDynamicPlugin } from "./loader";
import { pluginInstallDir, pluginPackageRoot } from "./paths";
import type { PluginPin } from "./pin-store";

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
    apply: async () => {},
    teardown: async () => {},
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
      ...(options.manifestExtra ?? {}),
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

const pin = (overrides: Partial<PluginPin> = {}): PluginPin => ({
  package: PACKAGE,
  declaredVersion: "^1.0.0",
  resolvedVersion: "1.2.0",
  ...overrides,
});

const fakeHost: PluginHost = {
  apiVersion: 1,
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
      [pin()],
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
      source: `export function createPlugin() { return { id: "acme-custom", kind: "capability", label: "x", description: "x", defaultSelected: false, isEnabled: () => false, apply: async () => {}, teardown: async () => {} }; }`,
    });

    const result = await loadDynamicPlugin(companionPath, declaration(), [pin()], {
      host: fakeHost,
    });
    expect(result.ok).toBe(true);
  });

  test("uninstalled package warns and points at install", async () => {
    const companionPath = await makeTempDir("plugin-load-uninstalled-");
    const result = await loadDynamicPlugin(companionPath, declaration(), [pin()], {
      host: fakeHost,
    });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.warning).toContain(PACKAGE);
    expect(result.warning).toContain("not installed");
  });

  test("missing pin is refused", async () => {
    const companionPath = await makeTempDir("plugin-load-nopin-");
    await writeInstalledPlugin(companionPath);
    const result = await loadDynamicPlugin(companionPath, declaration(), [], { host: fakeHost });
    if (result.ok) throw new Error("expected refusal");
    expect(result.warning).toContain("pin");
  });

  test("installed version differing from the pin is refused", async () => {
    const companionPath = await makeTempDir("plugin-load-pinmismatch-");
    await writeInstalledPlugin(companionPath, { version: "1.3.0" });
    const result = await loadDynamicPlugin(companionPath, declaration(), [pin()], {
      host: fakeHost,
    });
    if (result.ok) throw new Error("expected refusal");
    expect(result.warning).toContain("1.3.0");
    expect(result.warning).toContain("1.2.0");
  });

  test("edited declaration invalidates the pin at load time", async () => {
    const companionPath = await makeTempDir("plugin-load-declchange-");
    await writeInstalledPlugin(companionPath);
    const result = await loadDynamicPlugin(
      companionPath,
      declaration({ version: "^2.0.0" }),
      [pin()],
      {
        host: fakeHost,
      },
    );
    if (result.ok) throw new Error("expected refusal");
    expect(result.warning).toContain("^2.0.0");
  });

  test("unsupported plugin API version is refused before import", async () => {
    const companionPath = await makeTempDir("plugin-load-apiversion-");
    await writeInstalledPlugin(companionPath, {
      manifestExtra: { mate: { pluginApiVersion: 99 } },
      source: `throw new Error("must never execute");`,
    });

    const result = await loadDynamicPlugin(companionPath, declaration(), [pin()], {
      host: fakeHost,
    });
    if (result.ok) throw new Error("expected refusal");
    expect(result.warning).toContain("99");
    expect(result.warning).toContain("1");
  });

  test("missing pluginApiVersion defaults to 1 and loads", async () => {
    const companionPath = await makeTempDir("plugin-load-apidefault-");
    await writeInstalledPlugin(companionPath);
    const result = await loadDynamicPlugin(companionPath, declaration(), [pin()], {
      host: fakeHost,
    });
    expect(result.ok).toBe(true);
  });

  test("import errors are isolated into a warning", async () => {
    const companionPath = await makeTempDir("plugin-load-importerror-");
    await writeInstalledPlugin(companionPath, { source: `throw new Error("boom at import");` });
    const result = await loadDynamicPlugin(companionPath, declaration(), [pin()], {
      host: fakeHost,
    });
    if (result.ok) throw new Error("expected refusal");
    expect(result.warning).toContain("boom at import");
  });

  test("entry point without a factory export is an invalid plugin", async () => {
    const companionPath = await makeTempDir("plugin-load-nofactory-");
    await writeInstalledPlugin(companionPath, { source: `export const nothing = 1;` });
    const result = await loadDynamicPlugin(companionPath, declaration(), [pin()], {
      host: fakeHost,
    });
    if (result.ok) throw new Error("expected refusal");
    expect(result.warning).toContain("createPlugin");
  });

  test("unset interpolation variable skips the plugin naming the variable", async () => {
    const companionPath = await makeTempDir("plugin-load-envmissing-");
    await writeInstalledPlugin(companionPath);
    const result = await loadDynamicPlugin(
      companionPath,
      declaration({ config: { token: "${ACME_TOKEN}" } }),
      [pin()],
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
      [pin()],
      { host: fakeHost },
    );
    if (result.ok) throw new Error("expected refusal");
    expect(result.warning).toContain("rejected its configuration");
    expect(result.warning).toContain("companions must be a non-empty list");
  });

  test("resolves the entry point from an exports map", async () => {
    const companionPath = await makeTempDir("plugin-load-exports-");
    await writeInstalledPlugin(companionPath, {
      entryField: { exports: { ".": { default: "./index.js" } } },
    });
    const result = await loadDynamicPlugin(companionPath, declaration(), [pin()], {
      host: fakeHost,
    });
    expect(result.ok).toBe(true);
  });
});
