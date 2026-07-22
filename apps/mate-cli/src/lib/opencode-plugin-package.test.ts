import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  OPENCODE_PLUGIN_PACKAGE_NAME,
  getOpenCodeCacheDir,
  getOpenCodePluginPackageReference,
  isMateOpenCodePluginReference,
  opencodePluginCacheDeps,
  warmOpenCodePluginCache,
} from "./opencode-plugin-package";
import { getCurrentVersion } from "./update-checker";

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

describe("getOpenCodePluginPackageReference", () => {
  test("pins the plugin package to the coordinated CLI version", () => {
    expect(getOpenCodePluginPackageReference()).toBe(
      `${OPENCODE_PLUGIN_PACKAGE_NAME}@${getCurrentVersion()}`,
    );
    expect(getOpenCodePluginPackageReference("1.2.3-canary.4")).toBe(
      "@uniqbit/mate-opencode-plugin@1.2.3-canary.4",
    );
  });
});

describe("isMateOpenCodePluginReference", () => {
  test("matches the package root and pinned references only", () => {
    expect(isMateOpenCodePluginReference("@uniqbit/mate-opencode-plugin")).toBe(true);
    expect(isMateOpenCodePluginReference("@uniqbit/mate-opencode-plugin@0.14.4")).toBe(true);
    expect(isMateOpenCodePluginReference("@uniqbit/mate-opencode-plugin-fork@1.0.0")).toBe(false);
    expect(isMateOpenCodePluginReference("./plugins/mate-companion.ts")).toBe(false);
    expect(isMateOpenCodePluginReference(42)).toBe(false);
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

describe("warmOpenCodePluginCache", () => {
  test("prepares OpenCode's package spec directory and installs the pinned version", async () => {
    const cacheHome = await makeTempDir("mate-opencode-warm-");
    const reference = getOpenCodePluginPackageReference("1.2.3");
    const specDir = path.join(cacheHome, "opencode", "packages", reference);

    const runInstall = mock((cwd: string) => {
      const installedManifest = path.join(
        cwd,
        "node_modules",
        ...OPENCODE_PLUGIN_PACKAGE_NAME.split("/"),
        "package.json",
      );
      fsSync.mkdirSync(path.dirname(installedManifest), { recursive: true });
      fsSync.writeFileSync(installedManifest, "{}\n");
      return { error: undefined, status: 0, stderr: "" } as never;
    });
    opencodePluginCacheDeps.runInstall = runInstall;

    const result = await warmOpenCodePluginCache("1.2.3", { XDG_CACHE_HOME: cacheHome });

    expect(result.ok).toBe(true);
    expect(runInstall).toHaveBeenCalledWith(specDir);
    const manifest = JSON.parse(await fs.readFile(path.join(specDir, "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ [OPENCODE_PLUGIN_PACKAGE_NAME]: "1.2.3" });
  });

  test("reports a failed install without throwing", async () => {
    const cacheHome = await makeTempDir("mate-opencode-warm-fail-");
    opencodePluginCacheDeps.runInstall = mock(
      () => ({ error: undefined, status: 1, stderr: "E404 not found" }) as never,
    );

    const result = await warmOpenCodePluginCache("1.2.3", { XDG_CACHE_HOME: cacheHome });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("E404");
  });

  test("skips the pre-fetch when MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH is set", async () => {
    const runInstall = mock(() => ({ error: undefined, status: 0, stderr: "" }) as never);
    opencodePluginCacheDeps.runInstall = runInstall;

    const result = await warmOpenCodePluginCache("1.2.3", {
      MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH: "1",
      XDG_CACHE_HOME: "/nonexistent",
    });

    expect(result.ok).toBe(true);
    expect(runInstall).not.toHaveBeenCalled();
  });
});
