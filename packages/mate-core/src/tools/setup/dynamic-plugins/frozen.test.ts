import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { FrozenInstallError, installDeclaredPluginsFrozen } from "./frozen";
import { dynamicPluginsWorkspaceRoot } from "./paths";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const READER = { package: "@acme/reader", version: "^1.0.0" };
const WRITER = { package: "@acme/writer", version: "latest" };
const LOCKED = { "@acme/reader": { version: "1.2.0", integrity: "sha512-a" } };

async function workspace(options: {
  declared?: Record<string, string>;
  locked?: Record<string, { version: string; integrity: string }>;
  rootDeps?: Record<string, string>;
  lockfile?: boolean;
}): Promise<{ companion: string; root: string }> {
  const companion = await fs.mkdtemp(path.join(os.tmpdir(), "frozen-"));
  roots.push(companion);
  const root = dynamicPluginsWorkspaceRoot(companion);
  await fs.mkdir(root, { recursive: true });
  const declared = options.declared ?? { [READER.package]: READER.version };
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ private: true, dependencies: declared }),
  );
  if (options.lockfile !== false) {
    const locked = options.locked ?? LOCKED;
    await fs.writeFile(
      path.join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: options.rootDeps ?? declared },
          ...Object.fromEntries(Object.entries(locked).map(([n, e]) => [`node_modules/${n}`, e])),
        },
      }),
    );
  }
  return { companion, root };
}

/** Materializes the hidden lockfile npm leaves behind after an install. */
async function installTree(
  root: string,
  entries: Record<string, { version: string; integrity: string }>,
): Promise<void> {
  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  await fs.writeFile(
    path.join(root, "node_modules", ".package-lock.json"),
    JSON.stringify({
      packages: Object.fromEntries(
        Object.entries(entries).map(([n, e]) => [`node_modules/${n}`, e]),
      ),
    }),
  );
}

describe("installDeclaredPluginsFrozen", () => {
  test("refuses an unlisted package before npm runs", async () => {
    const { companion } = await workspace({});
    let ran = false;
    await expect(
      installDeclaredPluginsFrozen(companion, [READER], {
        env: { MATE_ALLOWED_PLUGINS: "@other/*" },
        runNpmCi: () => {
          ran = true;
          return { ok: true };
        },
      }),
    ).rejects.toThrow(/@acme\/reader.*not allowed/);
    expect(ran).toBe(false);
  });

  test("an explicitly empty allowlist refuses everything", async () => {
    const { companion } = await workspace({});
    await expect(
      installDeclaredPluginsFrozen(companion, [READER], { env: { MATE_ALLOWED_PLUGINS: "" } }),
    ).rejects.toBeInstanceOf(FrozenInstallError);
  });

  test("refuses an absent lockfile, manifest drift and lockfile drift", async () => {
    const none = await workspace({ lockfile: false });
    await expect(
      installDeclaredPluginsFrozen(none.companion, [READER], { env: {} }),
    ).rejects.toThrow(/package-lock\.json is missing/);
    const drift = await workspace({ declared: { [READER.package]: "^2.0.0" } });
    await expect(
      installDeclaredPluginsFrozen(drift.companion, [READER], { env: {} }),
    ).rejects.toThrow(/manifest disagrees.*@acme\/reader/);
    const stale = await workspace({ rootDeps: { [READER.package]: "^0.9.0" } });
    await expect(
      installDeclaredPluginsFrozen(stale.companion, [READER], { env: {} }),
    ).rejects.toThrow(/lockfile disagrees/);
  });

  test("a moving tag uses the locked version", async () => {
    const locked = { [WRITER.package]: { version: "3.1.0", integrity: "sha512-w" } };
    const { companion, root } = await workspace({
      declared: { [WRITER.package]: "latest" },
      locked,
    });
    await installTree(root, locked);
    const results = await installDeclaredPluginsFrozen(companion, [WRITER], { env: {} });
    expect(results).toEqual([
      { package: WRITER.package, status: "unchanged", resolvedVersion: "3.1.0" },
    ]);
  });

  test("reuses a matching tree without running npm", async () => {
    const { companion, root } = await workspace({});
    await installTree(root, LOCKED);
    const results = await installDeclaredPluginsFrozen(companion, [READER], {
      env: {},
      runNpmCi: () => {
        throw new Error("must not run");
      },
    });
    expect(results[0]?.status).toBe("unchanged");
  });

  test("restores when the tree disagrees on integrity, keeping tracked files", async () => {
    const { companion, root } = await workspace({});
    await installTree(root, { "@acme/reader": { version: "1.2.0", integrity: "sha512-OTHER" } });
    const before = await fs.readFile(path.join(root, "package-lock.json"), "utf8");
    let calls = 0;
    const results = await installDeclaredPluginsFrozen(companion, [READER], {
      env: {},
      runNpmCi: async (workspaceRoot) => {
        calls += 1;
        await installTree(workspaceRoot, LOCKED);
        return { ok: true };
      },
    });
    expect(calls).toBe(1);
    expect(results[0]).toMatchObject({ status: "installed", resolvedVersion: "1.2.0" });
    expect(await fs.readFile(path.join(root, "package-lock.json"), "utf8")).toBe(before);
  });

  test("a rejected registry token fails the package", async () => {
    const { companion } = await workspace({});
    const results = await installDeclaredPluginsFrozen(companion, [READER], {
      env: {},
      runNpmCi: () => ({ ok: false, detail: "E401 unauthorized" }),
    });
    expect(results).toEqual([
      { package: READER.package, status: "failed", error: "E401 unauthorized" },
    ]);
  });

  test("puts back tracked files a restore rewrote and fails", async () => {
    const { companion, root } = await workspace({});
    const before = await fs.readFile(path.join(root, "package-lock.json"), "utf8");
    const results = await installDeclaredPluginsFrozen(companion, [READER], {
      env: {},
      runNpmCi: async (workspaceRoot) => {
        await fs.writeFile(path.join(workspaceRoot, "package-lock.json"), "{}");
        await installTree(workspaceRoot, LOCKED);
        return { ok: true };
      },
    });
    expect(results[0]?.status).toBe("failed");
    expect(await fs.readFile(path.join(root, "package-lock.json"), "utf8")).toBe(before);
  });
});
