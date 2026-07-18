import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { GlobalConfigStore } from "./global-config-store";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("GlobalConfigStore", () => {
  test("list returns empty array when config is missing", async () => {
    const root = await makeTempDir("global-config-empty-");
    const store = new GlobalConfigStore(path.join(root, "config.yaml"));

    const companions = await store.list();

    expect(companions).toEqual([]);
  });

  test("register adds a companion path", async () => {
    const root = await makeTempDir("global-config-register-");
    const store = new GlobalConfigStore(path.join(root, "config.yaml"));
    const companionPath = path.join(root, "companion");
    await fs.mkdir(companionPath, { recursive: true });

    await store.register(companionPath);
    const companions = await store.list();

    expect(companions).toContain(path.resolve(companionPath));
  });

  test("list treats null companions as an empty array", async () => {
    const root = await makeTempDir("global-config-null-");
    const configPath = path.join(root, "config.yaml");
    await fs.writeFile(configPath, "version: 1\ncompanions:\n", "utf8");

    const companions = await new GlobalConfigStore(configPath).list();

    expect(companions).toEqual([]);
  });

  test("register does not add duplicate paths", async () => {
    const root = await makeTempDir("global-config-dup-");
    const store = new GlobalConfigStore(path.join(root, "config.yaml"));
    const companionPath = path.join(root, "companion");
    await fs.mkdir(companionPath, { recursive: true });

    await store.register(companionPath);
    await store.register(companionPath);
    const companions = await store.list();

    expect(companions.length).toBe(1);
  });

  test("register persists across store instances", async () => {
    const root = await makeTempDir("global-config-persist-");
    const configPath = path.join(root, "config.yaml");
    const companionPath = path.join(root, "companion");
    await fs.mkdir(companionPath, { recursive: true });

    await new GlobalConfigStore(configPath).register(companionPath);
    const companions = await new GlobalConfigStore(configPath).list();

    expect(companions).toContain(path.resolve(companionPath));
  });
});
