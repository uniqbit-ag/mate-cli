import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { main, type MainDeps } from "../../../cli/main";
import { resetActiveDistribution, setActiveDistribution } from "../../../distribution";
import { ConfigStore } from "../../../lib/orchestrator/config-store";
import { PluginRegistry } from "../registry";
import { hydrateDynamicPlugins, resetDynamicPluginHydration } from "./hydrate";
import { installDeclaredPlugins, type BunInstallRunner } from "./install";

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
  resetActiveDistribution();
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
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

/** Simulates `bun install` by materializing the fixture package at 1.2.0. */
const fakeBunInstall: BunInstallRunner = async (installDir) => {
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
    path.join(installDir, "bun.lock"),
    `{\n  "packages": {\n    "${PACKAGE}": ["${PACKAGE}@1.2.0", "", {}, "sha512-fixture"],\n  }\n}`,
    "utf8",
  );
  return { ok: true };
};

async function writeCompanion(options: { enabled: boolean; outFile: string }): Promise<string> {
  const companionPath = await makeTempDir("dynamic-plugins-e2e-");
  const configDir = path.join(companionPath, ".mate", "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "framework.yaml"),
    [
      "profiles:",
      "  default:",
      "    name: default",
      "    allowedAgents: []",
      ...(options.enabled ? ["capabilities:", "  - name: acme-custom"] : ["capabilities: []"]),
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
    config: { name: "acme-mate", runtime: "bun", version: "1.0.0" },
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
  test("declare → install/pin → hydrate → cap routing → enablement", async () => {
    const outFile = path.join(await makeTempDir("dynamic-plugins-out-"), "out.json");
    const companionPath = await writeCompanion({ enabled: true, outFile });
    const env = { ACME_GREETING: "hello from acme" };
    const registry = activateDistribution();

    // Install and pin.
    const installResults = await installDeclaredPlugins(
      companionPath,
      (await new ConfigStore(path.join(companionPath, ".mate", "config", "framework.yaml")).load())
        .plugins ?? [],
      { runBunInstall: fakeBunInstall },
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
    expect(output).toEqual({ argv: ["--flag"], greeting: "hello from acme", host: "acme-mate" });

    // Enablement flows through the existing capabilities machinery.
    const plugin = registry.getAll().find((candidate) => candidate.id === "acme-custom");
    expect(plugin).toBeDefined();
    expect(registry.getPolicy("acme-custom")).toBe("optional");
    expect(plugin!.isEnabled({ profiles: {}, capabilities: [{ name: "acme-custom" }] })).toBe(true);
    expect(plugin!.isEnabled({ profiles: {}, capabilities: [] })).toBe(false);
  });

  test("hydration warnings during a dynamic cap command stay on stderr", async () => {
    const outFile = path.join(await makeTempDir("dynamic-plugins-out-"), "out.json");
    const companionPath = await writeCompanion({ enabled: true, outFile });
    const env = { ACME_GREETING: "hi" };
    activateDistribution();
    await installDeclaredPlugins(companionPath, [{ package: PACKAGE, version: "^1.0.0" }], {
      runBunInstall: fakeBunInstall,
    });
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
        "profiles:",
        "  default:",
        "    name: default",
        "    allowedAgents: []",
        "plugins:",
        `  - package: "${PACKAGE}"`,
        '    version: "^1.0.0"',
        "",
      ].join("\n"),
      "utf8",
    );
    const registry = activateDistribution();
    await installDeclaredPlugins(companionPath, [{ package: PACKAGE, version: "^1.0.0" }], {
      runBunInstall: fakeBunInstall,
    });

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
