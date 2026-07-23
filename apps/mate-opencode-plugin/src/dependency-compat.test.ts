import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const packageRoot = path.resolve(import.meta.dirname, "..");

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

describe("plugin package dependency boundary", () => {
  test("owns every runtime dependency of the server and TUI entry points", async () => {
    const packageJson = await readJson<{ dependencies?: Record<string, string> }>(
      path.join(packageRoot, "package.json"),
    );

    expect(packageJson.dependencies?.["@opencode-ai/plugin"]).toBeDefined();
    expect(packageJson.dependencies?.["@opentui/core"]).toBeDefined();
    expect(packageJson.dependencies?.["@opentui/keymap"]).toBeDefined();
    expect(packageJson.dependencies?.["@opentui/solid"]).toBeDefined();
    expect(packageJson.dependencies?.["@uniqbit/mate-core"]).toBeDefined();
  });

  test("declares OpenTUI versions compatible with the resolved @opencode-ai/plugin peers", async () => {
    const packageJson = await readJson<{ dependencies: Record<string, string> }>(
      path.join(packageRoot, "package.json"),
    );
    const resolvedPluginManifest = await import.meta
      .resolve("@opencode-ai/plugin/package.json")
      .replace("file://", "");
    const opencodePlugin = await readJson<{ peerDependencies?: Record<string, string> }>(
      resolvedPluginManifest,
    );

    const peers = opencodePlugin.peerDependencies ?? {};
    for (const name of ["@opentui/core", "@opentui/keymap", "@opentui/solid"]) {
      const peerRange = peers[name];
      expect(peerRange).toBeDefined();

      // The declared range's minimum version must satisfy the peer floor, so
      // installs of the published plugin package resolve OpenTUI versions the
      // supported @opencode-ai/plugin release accepts.
      const declaredRange = packageJson.dependencies[name];
      const minimumVersion = declaredRange.replace(/^[\^~]/, "");
      expect(Bun.semver.satisfies(minimumVersion, peerRange!)).toBe(true);
    }
  });

  test("keeps the shared mate-core dependency pinned to the coordinated version", async () => {
    const packageJson = await readJson<{
      version: string;
      dependencies: Record<string, string>;
    }>(path.join(packageRoot, "package.json"));

    expect(packageJson.dependencies["@uniqbit/mate-core"]).toBe(packageJson.version);
  });
});
