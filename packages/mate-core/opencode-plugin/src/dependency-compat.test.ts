import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const coreRoot = path.resolve(import.meta.dirname, "..", "..");

const OPENTUI_PACKAGES = ["@opentui/core", "@opentui/keymap", "@opentui/solid"];

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

async function readCoreManifest(): Promise<PackageManifest> {
  return JSON.parse(
    await fs.readFile(path.join(coreRoot, "package.json"), "utf8"),
  ) as PackageManifest;
}

describe("bundled plugin dependency boundary", () => {
  test("mate-core owns the runtime dependencies of the server and TUI entry points", async () => {
    const manifest = await readCoreManifest();

    expect(manifest.dependencies?.["@opencode/plugin"]).toBeDefined();
    expect(manifest.dependencies?.["@opencode-ai/plugin"]).toBeUndefined();
  });

  /**
   * OpenCode's TUI host maps a plugin's `@opentui/*` and `solid-js` imports to
   * its own copies (OpenTUI's runtime plugin support), as `@opencode/plugin`
   * declares them too. A regular dependency would only make npm check
   * OpenTUI's `engines.node` (>=26.4) on every `npm i -g @uniqbit/mate`.
   */
  test("declares OpenTUI as optional host-provided peers, never as dependencies", async () => {
    const manifest = await readCoreManifest();

    for (const name of OPENTUI_PACKAGES) {
      expect(manifest.dependencies?.[name]).toBeUndefined();
      expect(manifest.peerDependencies?.[name]).toBeDefined();
      expect(manifest.peerDependenciesMeta?.[name]?.optional).toBe(true);
      expect(manifest.devDependencies?.[name]).toBeDefined();
    }
  });
});
