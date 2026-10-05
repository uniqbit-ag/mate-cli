import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const packageRoot = path.resolve(import.meta.dirname, "..");

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

const OPENTUI_PACKAGES = ["@opentui/core", "@opentui/keymap", "@opentui/solid"];

type PackageManifest = {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

function readOwnManifest(): Promise<PackageManifest> {
  return readJson<PackageManifest>(path.join(packageRoot, "package.json"));
}

describe("plugin package dependency boundary", () => {
  test("owns the non-host runtime dependencies of the server and TUI entry points", async () => {
    const packageJson = await readOwnManifest();

    expect(packageJson.dependencies?.["@opencode-ai/plugin"]).toBeDefined();
    expect(packageJson.dependencies?.["@uniqbit/mate-core"]).toBeDefined();
  });

  test("declares OpenTUI as optional host-provided peers, never as dependencies", async () => {
    const packageJson = await readOwnManifest();

    for (const name of OPENTUI_PACKAGES) {
      expect(packageJson.dependencies?.[name]).toBeUndefined();
      expect(packageJson.peerDependencies?.[name]).toBeDefined();
      expect(packageJson.peerDependenciesMeta?.[name]?.optional).toBe(true);
    }
  });

  test("declares OpenTUI peer floors compatible with the resolved @opencode-ai/plugin peers", async () => {
    const packageJson = await readOwnManifest();
    const resolvedPluginManifest = await import.meta
      .resolve("@opencode-ai/plugin/package.json")
      .replace("file://", "");
    const opencodePlugin = await readJson<PackageManifest>(resolvedPluginManifest);

    const hostPeers = opencodePlugin.peerDependencies ?? {};
    for (const name of OPENTUI_PACKAGES) {
      const hostRange = hostPeers[name];
      expect(hostRange).toBeDefined();

      const declaredRange = packageJson.peerDependencies?.[name];
      expect(declaredRange).toBeDefined();
      const minimumVersion = declaredRange!.replace(/^(?:>=|[\^~])/, "");
      expect(Bun.semver.satisfies(minimumVersion, hostRange!)).toBe(true);
    }
  });

  test("keeps the shared mate-core dependency pinned to the coordinated version", async () => {
    const packageJson = await readOwnManifest();

    expect(packageJson.dependencies?.["@uniqbit/mate-core"]).toBe(packageJson.version);
  });
});
