import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  getOpenCodeCacheDir,
  isLegacyMateOpenCodePluginReference,
  opencodePluginCacheDeps,
  warmOpenCodePackageCache,
} from "./opencode-plugin-package";
import { PUBLIC_NPM_REGISTRY } from "./public-npm";

const ACME_PACKAGE = "@acme/opencode-plugin";
const ACME_REFERENCE = `${ACME_PACKAGE}@1.2.3`;

const tempRoots: string[] = [];
const originalRunInstall = opencodePluginCacheDeps.runInstall;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  opencodePluginCacheDeps.runInstall = originalRunInstall;
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("isLegacyMateOpenCodePluginReference", () => {
  test("matches published, versioned and path-bound references to the retired package only", () => {
    expect(isLegacyMateOpenCodePluginReference("@uniqbit/mate-opencode-plugin")).toBe(true);
    expect(isLegacyMateOpenCodePluginReference("@uniqbit/mate-opencode-plugin@0.14.4")).toBe(true);
    expect(
      isLegacyMateOpenCodePluginReference(
        "/opt/acme/.mate/plugins/.local/node_modules/@uniqbit/mate-opencode-plugin",
      ),
    ).toBe(true);
    expect(isLegacyMateOpenCodePluginReference("@uniqbit/mate-opencode-plugin-fork@1.0.0")).toBe(
      false,
    );
    expect(isLegacyMateOpenCodePluginReference("/opt/acme/mate-core/opencode-plugin")).toBe(false);
    expect(isLegacyMateOpenCodePluginReference("./plugins/mate-companion.ts")).toBe(false);
    expect(isLegacyMateOpenCodePluginReference(42)).toBe(false);
  });
});

describe("getOpenCodeCacheDir", () => {
  test("prefers XDG_CACHE_HOME and falls back to ~/.cache", () => {
    expect(getOpenCodeCacheDir({ XDG_CACHE_HOME: "/custom/cache" })).toBe(
      path.join("/custom/cache", "opencode"),
    );
    expect(getOpenCodeCacheDir({})).toBe(path.join(os.homedir(), ".cache", "opencode"));
  });
});

describe("warmOpenCodePackageCache", () => {
  test("prepares OpenCode's package spec directory and installs the pinned version", async () => {
    const cacheHome = await makeTempDir("mate-opencode-warm-");
    const specDir = path.join(cacheHome, "opencode", "packages", ACME_REFERENCE);

    const runInstall = mock((cwd: string) => {
      const installedManifest = path.join(
        cwd,
        "node_modules",
        ...ACME_PACKAGE.split("/"),
        "package.json",
      );
      fsSync.mkdirSync(path.dirname(installedManifest), { recursive: true });
      fsSync.writeFileSync(installedManifest, "{}\n");
      return { error: undefined, status: 0, stderr: "" } as never;
    });
    opencodePluginCacheDeps.runInstall = runInstall;

    const registry = "https://npm.acme.test/";
    const result = await warmOpenCodePackageCache(
      ACME_PACKAGE,
      ACME_REFERENCE,
      { XDG_CACHE_HOME: cacheHome },
      registry,
    );

    expect(result.ok).toBe(true);
    expect(runInstall).toHaveBeenCalledWith(specDir, registry);
    const manifest = JSON.parse(await fs.readFile(path.join(specDir, "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ [ACME_PACKAGE]: "1.2.3" });
  });

  test("uses public npm by default", async () => {
    const cacheHome = await makeTempDir("mate-opencode-warm-default-");
    const runInstall = mock(() => ({ error: undefined, status: 1, stderr: "offline" }) as never);
    opencodePluginCacheDeps.runInstall = runInstall;

    await warmOpenCodePackageCache(ACME_PACKAGE, ACME_REFERENCE, { XDG_CACHE_HOME: cacheHome });

    expect(runInstall.mock.calls[0]?.[1]).toBe(PUBLIC_NPM_REGISTRY);
  });

  test("reports a failed install without throwing", async () => {
    const cacheHome = await makeTempDir("mate-opencode-warm-fail-");
    opencodePluginCacheDeps.runInstall = mock(
      () => ({ error: undefined, status: 1, stderr: "E404 not found" }) as never,
    );

    const result = await warmOpenCodePackageCache(ACME_PACKAGE, ACME_REFERENCE, {
      XDG_CACHE_HOME: cacheHome,
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("E404");
  });

  test("skips the pre-fetch when MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH is set", async () => {
    const runInstall = mock(() => ({ error: undefined, status: 0, stderr: "" }) as never);
    opencodePluginCacheDeps.runInstall = runInstall;

    const result = await warmOpenCodePackageCache(ACME_PACKAGE, ACME_REFERENCE, {
      MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH: "1",
      XDG_CACHE_HOME: "/nonexistent",
    });

    expect(result.ok).toBe(true);
    expect(runInstall).not.toHaveBeenCalled();
  });
});
