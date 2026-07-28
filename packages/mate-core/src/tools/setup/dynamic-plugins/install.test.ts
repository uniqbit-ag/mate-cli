import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import { installDeclaredPlugins, type BunInstallRunner } from "./install";
import { pluginInstallDir, pluginPackageRoot } from "./paths";
import { PluginPinStore } from "./pin-store";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Simulates `bun install` by materializing the declared dependency at a fixed version. */
function fakeBunInstall(resolveTo: (pkg: string, declared: string) => string): {
  runner: BunInstallRunner;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    runner: async (installDir) => {
      calls.push(installDir);
      const manifest = JSON.parse(
        await fs.readFile(path.join(installDir, "package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      for (const [pkg, declared] of Object.entries(manifest.dependencies)) {
        const version = resolveTo(pkg, declared);
        const root = path.join(installDir, "node_modules", ...pkg.split("/"));
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: pkg, version }),
          "utf8",
        );
        await fs.writeFile(
          path.join(installDir, "bun.lock"),
          `{\n  "packages": {\n    "${pkg}": ["${pkg}@${version}", "", {}, "sha512-fake-${version}"],\n  }\n}`,
          "utf8",
        );
      }
      return { ok: true };
    },
  };
}

const declaration = (overrides: Partial<PluginDeclaration> = {}): PluginDeclaration => ({
  package: "@acme/custom-plugin",
  version: "^1.0.0",
  ...overrides,
});

describe("installDeclaredPlugins", () => {
  test("fresh declaration installs and records a pin with integrity", async () => {
    const companionPath = await makeTempDir("plugin-install-fresh-");
    const { runner } = fakeBunInstall(() => "1.2.0");

    const results = await installDeclaredPlugins(companionPath, [declaration()], {
      runBunInstall: runner,
    });

    expect(results).toEqual([
      { package: "@acme/custom-plugin", status: "installed", resolvedVersion: "1.2.0" },
    ]);
    const pins = await new PluginPinStore(companionPath).load();
    expect(pins.plugins).toEqual([
      {
        package: "@acme/custom-plugin",
        declaredVersion: "^1.0.0",
        resolvedVersion: "1.2.0",
        integrity: "sha512-fake-1.2.0",
      },
    ]);
    const installed = JSON.parse(
      await fs.readFile(
        path.join(pluginPackageRoot(companionPath, "@acme/custom-plugin"), "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(installed.version).toBe("1.2.0");
  });

  test("matching pin and installed tree are left untouched", async () => {
    const companionPath = await makeTempDir("plugin-install-pinned-");
    const first = fakeBunInstall(() => "1.2.0");
    await installDeclaredPlugins(companionPath, [declaration()], {
      runBunInstall: first.runner,
    });

    // A newer version exists now, but the pinned range must stay put.
    const second = fakeBunInstall(() => "1.3.0");
    const results = await installDeclaredPlugins(companionPath, [declaration()], {
      runBunInstall: second.runner,
    });

    expect(second.calls).toEqual([]);
    expect(results).toEqual([
      { package: "@acme/custom-plugin", status: "unchanged", resolvedVersion: "1.2.0" },
    ]);
  });

  test("latest re-resolves on every run", async () => {
    const companionPath = await makeTempDir("plugin-install-latest-");
    const decl = declaration({ version: "latest" });
    await installDeclaredPlugins(companionPath, [decl], {
      runBunInstall: fakeBunInstall(() => "1.2.0").runner,
    });

    const second = fakeBunInstall(() => "1.3.0");
    const results = await installDeclaredPlugins(companionPath, [decl], {
      runBunInstall: second.runner,
    });

    expect(second.calls.length).toBe(1);
    expect(results[0]).toEqual({
      package: "@acme/custom-plugin",
      status: "installed",
      resolvedVersion: "1.3.0",
    });
    const pins = await new PluginPinStore(companionPath).load();
    expect(pins.plugins[0]?.resolvedVersion).toBe("1.3.0");
  });

  test("edited declared version invalidates the pin and re-resolves", async () => {
    const companionPath = await makeTempDir("plugin-install-edited-");
    await installDeclaredPlugins(companionPath, [declaration({ version: "^1.0.0" })], {
      runBunInstall: fakeBunInstall(() => "1.2.0").runner,
    });

    const second = fakeBunInstall(() => "2.1.0");
    const results = await installDeclaredPlugins(
      companionPath,
      [declaration({ version: "^2.0.0" })],
      {
        runBunInstall: second.runner,
      },
    );

    expect(second.calls.length).toBe(1);
    expect(results[0]?.resolvedVersion).toBe("2.1.0");
    const pins = await new PluginPinStore(companionPath).load();
    expect(pins.plugins[0]).toMatchObject({ declaredVersion: "^2.0.0", resolvedVersion: "2.1.0" });
  });

  test("missing installed tree with a matching pin reinstalls", async () => {
    const companionPath = await makeTempDir("plugin-install-repair-");
    await installDeclaredPlugins(companionPath, [declaration()], {
      runBunInstall: fakeBunInstall(() => "1.2.0").runner,
    });
    await fs.rm(pluginInstallDir(companionPath, "@acme/custom-plugin"), {
      recursive: true,
      force: true,
    });

    const second = fakeBunInstall(() => "1.2.0");
    const results = await installDeclaredPlugins(companionPath, [declaration()], {
      runBunInstall: second.runner,
    });

    expect(second.calls.length).toBe(1);
    expect(results[0]?.status).toBe("installed");
  });

  test("failed install reports the failure and records no pin", async () => {
    const companionPath = await makeTempDir("plugin-install-failed-");
    const results = await installDeclaredPlugins(companionPath, [declaration()], {
      runBunInstall: async () => ({ ok: false, detail: "registry unreachable" }),
    });

    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toContain("registry unreachable");
    const pins = await new PluginPinStore(companionPath).load();
    expect(pins.plugins).toEqual([]);
  });

  test("pins for undeclared packages are pruned", async () => {
    const companionPath = await makeTempDir("plugin-install-prune-");
    await installDeclaredPlugins(companionPath, [declaration()], {
      runBunInstall: fakeBunInstall(() => "1.2.0").runner,
    });

    await installDeclaredPlugins(companionPath, [], {
      runBunInstall: fakeBunInstall(() => "9.9.9").runner,
    });

    const pins = await new PluginPinStore(companionPath).load();
    expect(pins.plugins).toEqual([]);
  });
});
