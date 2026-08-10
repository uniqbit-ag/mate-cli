import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { ManifestCache, manifestsEqual } from "./manifest-cache";

const tempRoots: string[] = [];

async function makeCachePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-cache-"));
  tempRoots.push(dir);
  return path.join(dir, "cache", "mcp-manifests.json");
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("ManifestCache", () => {
  test("set/get round-trips and persists across instances", async () => {
    const cachePath = await makeCachePath();
    const cache = new ManifestCache(cachePath);

    await cache.set("hash-1", [{ name: "search" }], "docs-mcp --serve");

    const reloaded = new ManifestCache(cachePath);
    const entry = await reloaded.get("hash-1");
    expect(entry?.tools).toEqual([{ name: "search" }]);
    expect(entry?.command).toBe("docs-mcp --serve");
  });

  test("missing and corrupt cache files start empty", async () => {
    const cachePath = await makeCachePath();
    expect(await new ManifestCache(cachePath).get("x")).toBeUndefined();

    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, "{broken", "utf8");
    expect(await new ManifestCache(cachePath).get("x")).toBeUndefined();
  });

  test("list returns all entries", async () => {
    const cache = new ManifestCache(await makeCachePath());
    await cache.set("a", [{ name: "one" }], "one-bin");
    await cache.set("b", [{ name: "two" }], "two-bin");

    expect((await cache.list()).map((entry) => entry.configHash).sort()).toEqual(["a", "b"]);
  });
});

describe("manifestsEqual", () => {
  test("ignores key order but not values", () => {
    expect(
      manifestsEqual(
        [{ name: "a", inputSchema: { type: "object", properties: {} } }],
        [{ inputSchema: { properties: {}, type: "object" }, name: "a" }],
      ),
    ).toBe(true);
    expect(manifestsEqual([{ name: "a" }], [{ name: "b" }])).toBe(false);
    expect(manifestsEqual([{ name: "a" }], [{ name: "a" }, { name: "b" }])).toBe(false);
  });
});
