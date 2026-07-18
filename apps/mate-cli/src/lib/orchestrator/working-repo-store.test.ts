import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { stringify } from "yaml";

import { ConfigError } from "./types";
import { WorkingRepoStore } from "./working-repo-store";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("WorkingRepoStore", () => {
  test("throws ConfigError when registry file is missing", async () => {
    const root = await makeTempDir("working-repo-missing-");
    const store = new WorkingRepoStore(path.join(root, "registry.yaml"));

    await expect(store.load()).rejects.toThrow(ConfigError);
  });

  test("round-trips saved config", async () => {
    const root = await makeTempDir("working-repo-roundtrip-");
    const store = new WorkingRepoStore(path.join(root, "registry.yaml"));
    const config = WorkingRepoStore.defaultConfig();
    config.repos.push({ id: "app", path: "/some/path", profile: "default" });

    await store.save(config);
    const loaded = await store.load();

    expect(loaded).toEqual(config);
  });

  test("strips legacy activeRepoId field on load (migration)", async () => {
    const root = await makeTempDir("working-repo-migrate-");
    const registryPath = path.join(root, "registry.yaml");
    await fs.writeFile(
      registryPath,
      stringify({
        repos: [{ id: "app", path: "/some/path", profile: "default" }],
        activeRepoId: "app",
      }),
      "utf8",
    );

    const store = new WorkingRepoStore(registryPath);
    const loaded = await store.load();

    expect(loaded).toEqual({ repos: [{ id: "app", path: "/some/path", profile: "default" }] });
    expect("activeRepoId" in loaded).toBe(false);
  });
});
