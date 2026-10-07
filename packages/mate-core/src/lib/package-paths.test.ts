import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  getActiveDistribution,
  resetActiveDistribution,
  setActiveDistribution,
} from "../distribution";
import { getOpenCodePluginRoot, validateOpenCodePluginAssets } from "./package-paths";

const tempRoots: string[] = [];

afterEach(async () => {
  resetActiveDistribution();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function useAssetRoots(assetRoots: string[]): void {
  const { config, registry } = getActiveDistribution();
  setActiveDistribution({ config: { ...config, assetRoots }, registry });
}

describe("getOpenCodePluginRoot", () => {
  test("defaults to mate-core's bundled opencode-plugin directory", () => {
    const root = getOpenCodePluginRoot();

    expect(path.isAbsolute(root)).toBe(true);
    expect(root).toBe(path.resolve(import.meta.dirname, "..", "..", "opencode-plugin"));
  });

  test("prefers the first distribution asset root that ships opencode-plugin/", async () => {
    const bare = await makeTempDir("acme-assets-bare-");
    const shipping = await makeTempDir("acme-assets-plugin-");
    await fs.mkdir(path.join(shipping, "opencode-plugin"));
    useAssetRoots([bare, shipping]);

    expect(getOpenCodePluginRoot()).toBe(path.join(shipping, "opencode-plugin"));
  });

  test("falls back to the bundled copy when no asset root ships it", async () => {
    useAssetRoots([await makeTempDir("acme-assets-bare-")]);

    expect(getOpenCodePluginRoot()).toBe(
      path.resolve(import.meta.dirname, "..", "..", "opencode-plugin"),
    );
  });
});

describe("validateOpenCodePluginAssets", () => {
  test("accepts the bundled plugin", () => {
    expect(() => validateOpenCodePluginAssets()).not.toThrow();
  });

  test("names every missing entry and tells the user to reinstall", async () => {
    const broken = await makeTempDir("acme-opencode-plugin-broken-");

    expect(() => validateOpenCodePluginAssets(broken)).toThrow(/server\.ts/);
    expect(() => validateOpenCodePluginAssets(broken)).toThrow(/tui\.tsx/);
    expect(() => validateOpenCodePluginAssets(broken)).toThrow(/[Rr]einstall/);
  });
});
