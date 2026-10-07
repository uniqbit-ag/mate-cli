import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const coreRoot = path.resolve(import.meta.dirname, "..", "..");

const OPENTUI_PACKAGES = ["@opentui/core", "@opentui/keymap", "@opentui/solid"];

type PackageManifest = {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
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

  test("declares OpenTUI as regular dependencies: OpenCode does not provide it to path-loaded plugins", async () => {
    const manifest = await readCoreManifest();

    for (const name of OPENTUI_PACKAGES) {
      expect(manifest.dependencies?.[name]).toBeDefined();
      expect(manifest.peerDependencies?.[name]).toBeUndefined();
    }
  });
});
