import { fakePluginInstallDeps } from "../../../../test/plugin-install";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createTempDir, overrideEnv } from "../../../../../../test/fixtures";
import { main, type MainDeps } from "../../../cli/main";
import { collectDoctorReport } from "../../../cli/commands/doctor";
import { resetActiveDistribution, setActiveDistribution } from "../../../distribution";
import { ConfigStore } from "../../../lib/orchestrator/config-store";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { syncCompanionFiles } from "../../setup";
import type { ProviderPlugin } from "../plugin";
import { PluginRegistry } from "../registry";
import { hydrateDynamicPlugins, resetDynamicPluginHydration } from "./hydrate";
import { installDeclaredPlugins, type NpmInstallRunner } from "./install";

const tempRoots: string[] = [];
let restoreEnvironment: () => void;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  tempRoots.push(dir);
  return dir;
}

beforeEach(() => {
  resetDynamicPluginHydration();
  restoreEnvironment = overrideEnv({ MATE_ARTIFACT_PATH: undefined, MATE_REPO_ID: undefined });
});

afterEach(async () => {
  resetActiveDistribution();
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  restoreEnvironment();
});

const PACKAGE = "@acme/custom-plugin";

// The fixture package: validates its config, contributes an MCP-style cap
// command, and reaches the core only through the injected host.
const FIXTURE_SOURCE = `
import fs from "node:fs";
export default function createPlugin(config, host) {
  if (!config || typeof config.outFile !== "string") {
    throw new Error("outFile is required");
  }
  return {
    id: "acme-custom",
    kind: "capability",
    label: "Acme Custom",
    description: "integration fixture",
    defaultSelected: false,
    isEnabled: (frameworkConfig) =>
      (frameworkConfig.capabilities ?? []).some((capability) => capability.name === "acme-custom"),
    apply: async () => {},
    teardown: async () => {},
    cliCommands: [
      {
        name: "mcp",
        description: "fixture MCP server",
        run: async (argv) => {
          fs.writeFileSync(
            config.outFile,
            JSON.stringify({ argv, greeting: config.greeting, host: host.distribution.name }),
          );
          process.stdout.write("MCP-OUT\\n");
        },
      },
    ],
  };
}
`;

/** Simulates `npm install` by materializing the fixture package at 1.2.0. */
const fakeNpmInstall: NpmInstallRunner = async (installDir) => {
  const root = path.join(installDir, "node_modules", ...PACKAGE.split("/"));
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: PACKAGE,
      version: "1.2.0",
      type: "module",
      main: "index.js",
      mate: { pluginApiVersion: 1 },
    }),
    "utf8",
  );
  await fs.writeFile(path.join(root, "index.js"), FIXTURE_SOURCE, "utf8");
  await fs.writeFile(
    path.join(installDir, "package-lock.json"),
    JSON.stringify({ packages: { [`node_modules/${PACKAGE}`]: { version: "1.2.0" } } }, null, 2),
    "utf8",
  );
  return { ok: true };
};

async function writeCompanion(options: { outFile: string }): Promise<string> {
  const companionPath = await makeTempDir("dynamic-plugins-e2e-");
  const configDir = path.join(companionPath, ".mate", "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "framework.yaml"),
    [
      "allowedAgents: []",
      "capabilities: []",
      "plugins:",
      `  - package: "${PACKAGE}"`,
      '    version: "^1.0.0"',
      "    config:",
      `      outFile: "${options.outFile}"`,
      "      greeting: ${ACME_GREETING}",
      "",
    ].join("\n"),
    "utf8",
  );
  return companionPath;
}

function activateDistribution(): PluginRegistry {
  const registry = new PluginRegistry([]);
  setActiveDistribution({
    config: { runtime: "bun", version: "1.0.0" },
    registry,
  });
  return registry;
}

function mainDeps(companionPath: string, env: Record<string, string | undefined>): MainDeps {
  return {
    ensureUnambiguousCompanion: async () => true,
    inspectInstallPreflight: async () => ({ ok: true }),
    hydrateDynamicPlugins: () => hydrateDynamicPlugins({ companionPath, env }),
  };
}

describe("dynamic plugins end to end", () => {
  test("declare → install → hydrate → cap routing → enablement", async () => {
    const outFile = path.join(await makeTempDir("dynamic-plugins-out-"), "out.json");
    const companionPath = await writeCompanion({ outFile });
    const env = { ACME_GREETING: "hello from acme" };
    const registry = activateDistribution();

    // Install into the shared workspace.
    const installResults = await installDeclaredPlugins(
      companionPath,
      (await new ConfigStore(path.join(companionPath, ".mate", "config", "framework.yaml")).load())
        .plugins ?? [],
      fakePluginInstallDeps({ runNpmInstall: fakeNpmInstall }),
    );
    expect(installResults).toEqual([
      { package: PACKAGE, status: "installed", resolvedVersion: "1.2.0" },
    ]);

    // Full CLI path: hydration happens inside main, then cap routing.
    await main(
      ["node", "acme-mate", "cap", "acme-custom", "mcp", "--flag"],
      mainDeps(companionPath, env),
    );

    const output = JSON.parse(await fs.readFile(outFile, "utf8")) as {
      argv: string[];
      greeting: string;
      host: string;
    };
    expect(output).toEqual({ argv: ["--flag"], greeting: "hello from acme", host: "mate" });

    const plugin = registry.getAll().find((candidate) => candidate.id === "acme-custom");
    expect(plugin).toBeDefined();
    expect(registry.getPolicy("acme-custom")).toBe("optional");
    expect(plugin!.isEnabled({ allowedAgents: [], capabilities: [] })).toBe(true);
  });

  test("hydration warnings during a dynamic cap command stay on stderr", async () => {
    const outFile = path.join(await makeTempDir("dynamic-plugins-out-"), "out.json");
    const companionPath = await writeCompanion({ outFile });
    const env = { ACME_GREETING: "hi" };
    activateDistribution();
    await installDeclaredPlugins(
      companionPath,
      [{ package: PACKAGE, version: "^1.0.0" }],
      fakePluginInstallDeps({
        runNpmInstall: fakeNpmInstall,
      }),
    );
    // A second, broken declaration: declared but never installed.
    const configPath = path.join(companionPath, ".mate", "config", "framework.yaml");
    await fs.appendFile(
      configPath,
      ['  - package: "@acme/missing"', '    version: "1.0.0"', ""].join("\n"),
      "utf8",
    );

    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    try {
      await main(["node", "acme-mate", "cap", "acme-custom", "mcp"], mainDeps(companionPath, env));
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    // stdout carries only the command's own output; the missing-plugin
    // warning lands on stderr.
    expect(stdoutWrites.join("")).toBe("MCP-OUT\n");
    expect(stderrWrites.join("")).toContain("@acme/missing");

    // The broken plugin was skipped; the healthy one still ran.
    const output = JSON.parse(await fs.readFile(outFile, "utf8")) as { greeting: string };
    expect(output.greeting).toBe("hi");
  });

  test("config validation rejection is reported per-plugin without breaking the CLI", async () => {
    const companionPath = await makeTempDir("dynamic-plugins-reject-");
    const configDir = path.join(companionPath, ".mate", "config");
    await fs.mkdir(configDir, { recursive: true });
    // outFile missing → the fixture factory throws.
    await fs.writeFile(
      path.join(configDir, "framework.yaml"),
      [
        "allowedAgents: []",
        "plugins:",
        `  - package: "${PACKAGE}"`,
        '    version: "^1.0.0"',
        "",
      ].join("\n"),
      "utf8",
    );
    const registry = activateDistribution();
    await installDeclaredPlugins(
      companionPath,
      [{ package: PACKAGE, version: "^1.0.0" }],
      fakePluginInstallDeps({
        runNpmInstall: fakeNpmInstall,
      }),
    );

    const warnings: string[] = [];
    await hydrateDynamicPlugins({
      companionPath,
      env: {},
      warn: (message) => warnings.push(message),
    });

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("rejected its configuration");
    expect(warnings[0]).toContain("outFile is required");
    expect(registry.getAll()).toEqual([]);
  });
});

const SHIPPER = "@acme/claude-shipper";

/** A dynamic plugin that ships a Claude plugin folder inside its own package. */
const SHIPPER_SOURCE = `
import { fileURLToPath } from "node:url";
const pluginDir = fileURLToPath(new URL("./claude-plugin", import.meta.url));
export default function createPlugin() {
  return {
    id: "acme-shipper",
    kind: "capability",
    label: "Acme Shipper",
    description: "ships a Claude plugin folder",
    defaultSelected: false,
    isEnabled: () => false,
    apply: async () => {},
    teardown: async () => {},
    getRuntimeContributions: () => ({ claude: { pluginDirectories: [{ path: pluginDir }] } }),
  };
}
`;

const shipperNpmInstall: NpmInstallRunner = async (installDir) => {
  const root = path.join(installDir, "node_modules", ...SHIPPER.split("/"));
  await fs.mkdir(path.join(root, "claude-plugin", ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: SHIPPER,
      version: "1.0.0",
      type: "module",
      main: "index.js",
      mate: { pluginApiVersion: 1 },
    }),
    "utf8",
  );
  await fs.writeFile(path.join(root, "index.js"), SHIPPER_SOURCE, "utf8");
  await fs.writeFile(
    path.join(root, "claude-plugin", ".claude-plugin", "plugin.json"),
    '{"name":"acme-shipper"}\n',
    "utf8",
  );
  await fs.writeFile(
    path.join(installDir, "package-lock.json"),
    JSON.stringify({ packages: { [`node_modules/${SHIPPER}`]: { version: "1.0.0" } } }, null, 2),
    "utf8",
  );
  return { ok: true };
};

const claudeProvider: ProviderPlugin = {
  id: "claude",
  kind: "provider",
  label: "Claude",
  description: "fixture runtime",
  defaultSelected: true,
  isEnabled: () => true,
  apply: async () => {},
  teardown: async () => {},
};

describe("dynamic plugin Claude plugin folders", () => {
  async function companionWithShipper() {
    const companionPath = await makeTempDir("dynamic-plugins-claude-");
    const configPath = path.join(companionPath, ".mate", "config", "framework.yaml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const declared = ["allowedAgents: [claude]", "capabilities: []"];
    await fs.writeFile(
      configPath,
      [...declared, "plugins:", `  - package: "${SHIPPER}"`, '    version: "^1.0.0"', ""].join(
        "\n",
      ),
      "utf8",
    );
    await installDeclaredPlugins(
      companionPath,
      [{ package: SHIPPER, version: "^1.0.0" }],
      fakePluginInstallDeps({
        runNpmInstall: shipperNpmInstall,
      }),
    );
    return { companionPath, configPath, declared };
  }

  test("doctor lists a declared Claude plugin from a companion subdirectory", async () => {
    const { companionPath } = await companionWithShipper();
    const cwd = path.join(companionPath, "docs");
    await fs.mkdir(cwd);
    activateDistribution().register(claudeProvider);

    const report = await collectDoctorReport({
      cwd,
      env: {},
      globalConfigStore: new GlobalConfigStore(path.join(companionPath, "global.yaml")),
    });

    expect(report).toMatchObject({
      kind: "companion",
      pluginCapabilities: ["acme-shipper"],
      pluginFailures: [],
      claudePlugins: [
        {
          capability: "acme-shipper",
          path: path.join(
            companionPath,
            ".mate",
            "plugins",
            "node_modules",
            ...SHIPPER.split("/"),
            "claude-plugin",
          ),
          loadable: true,
        },
      ],
    });
  });

  test("a declared plugin's folder is gathered, and not once its declaration is removed", async () => {
    const { companionPath, configPath, declared } = await companionWithShipper();
    const syncFresh = async () => {
      resetDynamicPluginHydration();
      activateDistribution().register(claudeProvider);
      await hydrateDynamicPlugins({ companionPath, env: {} });
      return (await syncCompanionFiles(companionPath, await new ConfigStore(configPath).load()))
        .claudePluginFolders;
    };

    const withDeclaration = await syncFresh();
    expect(withDeclaration.loadWarnings).toEqual([]);
    expect(withDeclaration.launch).toHaveLength(1);
    expect(withDeclaration.launch[0]).toEndWith(path.join(...SHIPPER.split("/"), "claude-plugin"));

    await fs.writeFile(configPath, [...declared, ""].join("\n"), "utf8");
    expect(await syncFresh()).toMatchObject({ launch: [], loadWarnings: [] });
  });
});
