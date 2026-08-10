import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { stringify } from "yaml";

import { CompanionRegistryStore } from "./companion-registry-store";
import { ConfigError } from "./types";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("CompanionRegistryStore", () => {
  test("throws ConfigError when registry file is missing", async () => {
    const root = await makeTempDir("companion-registry-missing-");
    const store = new CompanionRegistryStore(path.join(root, "registry.yaml"));

    await expect(store.load()).rejects.toThrow(ConfigError);
  });

  test("round-trips saved config", async () => {
    const root = await makeTempDir("companion-registry-roundtrip-");
    const store = new CompanionRegistryStore(path.join(root, "registry.yaml"));
    const config = CompanionRegistryStore.defaultConfig();
    config.repos.push({ id: "app", path: "/some/path" });

    await store.save(config);
    const loaded = await store.load();

    expect(loaded).toEqual(config);
  });

  test("strips legacy activeRepoId field on load (migration)", async () => {
    const root = await makeTempDir("companion-registry-migrate-");
    const registryPath = path.join(root, "registry.yaml");
    await fs.writeFile(
      registryPath,
      stringify({
        repos: [{ id: "app", path: "/some/path" }],
        activeRepoId: "app",
      }),
      "utf8",
    );

    const store = new CompanionRegistryStore(registryPath);
    const loaded = await store.load();

    expect(loaded).toEqual({ repos: [{ id: "app", path: "/some/path" }] });
    expect("activeRepoId" in loaded).toBe(false);
  });

  test("strips legacy profile and overrides fields from repo entries on load", async () => {
    const root = await makeTempDir("companion-registry-legacy-policy-");
    const registryPath = path.join(root, "registry.yaml");
    await fs.writeFile(
      registryPath,
      stringify({
        repos: [
          {
            id: "app",
            path: "/some/path",
            profile: "default",
            overrides: { allowedAgents: ["claude"] },
          },
        ],
      }),
      "utf8",
    );

    const store = new CompanionRegistryStore(registryPath);
    const loaded = await store.load();

    expect(loaded).toEqual({ repos: [{ id: "app", path: "/some/path" }] });

    await store.save(loaded);
    const written = await fs.readFile(registryPath, "utf8");
    expect(written).not.toContain("profile");
    expect(written).not.toContain("overrides");
  });
});
