import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { PluginDeclaration } from "../../../lib/orchestrator/types";
import { installDeclaredPlugins, type NpmInstallRunner, type NpmUpdateRunner } from "./install";
import { dynamicPluginsWorkspaceRoot, pluginPackageRoot } from "./paths";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Simulates `npm install` by materializing every declared dependency at a fixed version. */
function fakeNpmInstall(resolveTo: (pkg: string, declared: string) => string): {
  runner: NpmInstallRunner;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    runner: async (workspaceRoot) => {
      calls.push(workspaceRoot);
      const manifest = JSON.parse(
        await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      for (const [pkg, declared] of Object.entries(manifest.dependencies)) {
        const version = resolveTo(pkg, declared);
        const root = path.join(workspaceRoot, "node_modules", ...pkg.split("/"));
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: pkg, version }),
          "utf8",
        );
      }
      return { ok: true };
    },
  };
}

/** Simulates `npm update <pkg...>` by re-materializing only the named packages. */
function fakeNpmUpdate(resolveTo: (pkg: string) => string): {
  runner: NpmUpdateRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (workspaceRoot, packages) => {
      calls.push(packages);
      for (const pkg of packages) {
        const version = resolveTo(pkg);
        const root = path.join(workspaceRoot, "node_modules", ...pkg.split("/"));
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: pkg, version }),
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
  test("fresh declaration installs into the shared workspace", async () => {
    const companionPath = await makeTempDir("plugin-install-fresh-");
    const { runner } = fakeNpmInstall(() => "1.2.0");

    const results = await installDeclaredPlugins(companionPath, [declaration()], {
      runNpmInstall: runner,
    });

    expect(results).toEqual([
      { package: "@acme/custom-plugin", status: "installed", resolvedVersion: "1.2.0" },
    ]);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(dynamicPluginsWorkspaceRoot(companionPath), "package.json"),
        "utf8",
      ),
    ) as { private: boolean; dependencies: Record<string, string> };
    expect(manifest).toEqual({
      private: true,
      dependencies: { "@acme/custom-plugin": "^1.0.0" },
    });
    const installed = JSON.parse(
      await fs.readFile(
        path.join(pluginPackageRoot(companionPath, "@acme/custom-plugin"), "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(installed.version).toBe("1.2.0");
  });

  test("multiple declared plugins install together in a single run", async () => {
    const companionPath = await makeTempDir("plugin-install-multi-");
    const { runner, calls } = fakeNpmInstall((pkg) => (pkg === "@acme/a" ? "1.0.0" : "2.0.0"));

    const results = await installDeclaredPlugins(
      companionPath,
      [declaration({ package: "@acme/b", version: "^2.0.0" }), declaration({ package: "@acme/a" })],
      { runNpmInstall: runner },
    );

    expect(calls.length).toBe(1);
    expect(results).toEqual([
      { package: "@acme/a", status: "installed", resolvedVersion: "1.0.0" },
      { package: "@acme/b", status: "installed", resolvedVersion: "2.0.0" },
    ]);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(dynamicPluginsWorkspaceRoot(companionPath), "package.json"),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    // Sorted by package name for a stable diff.
    expect(Object.keys(manifest.dependencies)).toEqual(["@acme/a", "@acme/b"]);
  });

  test("unchanged declarations are left untouched", async () => {
    const companionPath = await makeTempDir("plugin-install-unchanged-");
    const first = fakeNpmInstall(() => "1.2.0");
    await installDeclaredPlugins(companionPath, [declaration()], { runNpmInstall: first.runner });

    // A newer version exists now, but the declared range must stay put.
    const second = fakeNpmInstall(() => "1.3.0");
    const results = await installDeclaredPlugins(companionPath, [declaration()], {
      runNpmInstall: second.runner,
    });

    expect(second.calls).toEqual([]);
    expect(results).toEqual([
      { package: "@acme/custom-plugin", status: "unchanged", resolvedVersion: "1.2.0" },
    ]);
  });

  test("latest re-resolves via npm update on every run, even when nothing else changed", async () => {
    const companionPath = await makeTempDir("plugin-install-latest-");
    const decl = declaration({ version: "latest" });
    await installDeclaredPlugins(companionPath, [decl], {
      runNpmInstall: fakeNpmInstall(() => "1.2.0").runner,
    });

    const install = fakeNpmInstall(() => "1.2.0");
    const update = fakeNpmUpdate(() => "1.3.0");
    const results = await installDeclaredPlugins(companionPath, [decl], {
      runNpmInstall: install.runner,
      runNpmUpdate: update.runner,
    });

    expect(update.calls).toEqual([["@acme/custom-plugin"]]);
    expect(results).toEqual([
      { package: "@acme/custom-plugin", status: "installed", resolvedVersion: "1.3.0" },
    ]);
  });

  test("npm update only targets the latest-declared subset", async () => {
    const companionPath = await makeTempDir("plugin-install-latest-subset-");
    const pinned = declaration({ package: "@acme/pinned", version: "^1.0.0" });
    const latest = declaration({ package: "@acme/latest", version: "latest" });
    await installDeclaredPlugins(companionPath, [pinned, latest], {
      runNpmInstall: fakeNpmInstall(() => "1.0.0").runner,
    });

    const install = fakeNpmInstall(() => "1.0.0");
    const update = fakeNpmUpdate(() => "1.1.0");
    const results = await installDeclaredPlugins(companionPath, [pinned, latest], {
      runNpmInstall: install.runner,
      runNpmUpdate: update.runner,
    });

    expect(update.calls).toEqual([["@acme/latest"]]);
    expect(results).toEqual([
      { package: "@acme/latest", status: "installed", resolvedVersion: "1.1.0" },
      { package: "@acme/pinned", status: "installed", resolvedVersion: "1.0.0" },
    ]);
  });

  test("edited declared version invalidates the diff and re-resolves", async () => {
    const companionPath = await makeTempDir("plugin-install-edited-");
    await installDeclaredPlugins(companionPath, [declaration({ version: "^1.0.0" })], {
      runNpmInstall: fakeNpmInstall(() => "1.2.0").runner,
    });

    const second = fakeNpmInstall(() => "2.1.0");
    const results = await installDeclaredPlugins(
      companionPath,
      [declaration({ version: "^2.0.0" })],
      { runNpmInstall: second.runner },
    );

    expect(second.calls.length).toBe(1);
    expect(results[0]?.resolvedVersion).toBe("2.1.0");
  });

  test("missing installed tree reinstalls even though the manifest is unchanged", async () => {
    const companionPath = await makeTempDir("plugin-install-repair-");
    await installDeclaredPlugins(companionPath, [declaration()], {
      runNpmInstall: fakeNpmInstall(() => "1.2.0").runner,
    });
    await fs.rm(pluginPackageRoot(companionPath, "@acme/custom-plugin"), {
      recursive: true,
      force: true,
    });

    const second = fakeNpmInstall(() => "1.2.0");
    const results = await installDeclaredPlugins(companionPath, [declaration()], {
      runNpmInstall: second.runner,
    });

    expect(second.calls.length).toBe(1);
    expect(results[0]?.status).toBe("installed");
  });

  test("failed install reports the failure for every declared plugin", async () => {
    const companionPath = await makeTempDir("plugin-install-failed-");
    const results = await installDeclaredPlugins(companionPath, [declaration()], {
      runNpmInstall: async () => ({ ok: false, detail: "registry unreachable" }),
    });

    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toContain("registry unreachable");
  });

  test("undeclared packages are pruned from the shared workspace on the next run", async () => {
    const companionPath = await makeTempDir("plugin-install-prune-");
    await installDeclaredPlugins(companionPath, [declaration()], {
      runNpmInstall: fakeNpmInstall(() => "1.2.0").runner,
    });

    const second = fakeNpmInstall(() => "9.9.9");
    await installDeclaredPlugins(companionPath, [], { runNpmInstall: second.runner });

    expect(second.calls.length).toBe(1);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(dynamicPluginsWorkspaceRoot(companionPath), "package.json"),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies).toEqual({});
  });

  test("no declared plugins and no prior workspace is a no-op", async () => {
    const companionPath = await makeTempDir("plugin-install-empty-");
    const { runner, calls } = fakeNpmInstall(() => "1.0.0");

    const results = await installDeclaredPlugins(companionPath, [], { runNpmInstall: runner });

    expect(results).toEqual([]);
    expect(calls).toEqual([]);
    await expect(fs.access(dynamicPluginsWorkspaceRoot(companionPath))).rejects.toThrow();
  });
});
