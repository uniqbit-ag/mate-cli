import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { ConfigStore, mergeWithDefaults } from "./config-store";
import type { FrameworkConfig } from "./types";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("engines parsing", () => {
  test("framework.yaml without an engines key parses with engines undefined", async () => {
    const root = await makeTempDir("config-store-engines-none-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(
      configPath,
      "profiles:\n  default:\n    name: default\n    allowedAgents:\n      - claude\n",
      "utf8",
    );

    const config = await new ConfigStore(configPath).load();
    expect(config.engines).toBeUndefined();
    expect(config.profiles.default?.allowedAgents).toEqual(["claude"]);
  });

  test("framework.yaml with engines.mate parses into config", async () => {
    const root = await makeTempDir("config-store-engines-mate-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(
      configPath,
      "profiles:\n  default:\n    name: default\n    allowedAgents: []\nengines:\n  mate: '>=0.15.0'\n",
      "utf8",
    );

    const config = await new ConfigStore(configPath).load();
    expect(config.engines?.mate).toBe(">=0.15.0");
  });

  test("framework.yaml with a custom distribution engines key parses into config", async () => {
    const root = await makeTempDir("config-store-engines-custom-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(
      configPath,
      "profiles:\n  default:\n    name: default\n    allowedAgents: []\nengines:\n  acme-mate: '>=1.2.0'\n",
      "utf8",
    );

    const config = await new ConfigStore(configPath).load();
    expect(config.engines?.["acme-mate"]).toBe(">=1.2.0");
  });
});

describe("mergeWithDefaults", () => {
  test("adds default capabilities when existing config has none", () => {
    const existing: FrameworkConfig = {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
    };

    const merged = mergeWithDefaults(existing);

    const names = merged.capabilities?.map((c) => c.name);
    expect(names).toContain("react-doctor");
    expect(names).toContain("openspec");
  });

  test("does not duplicate capabilities already present", () => {
    const existing: FrameworkConfig = {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [{ name: "react-doctor" }],
    };

    const merged = mergeWithDefaults(existing);

    const count = merged.capabilities?.filter((c) => c.name === "react-doctor").length;
    expect(count).toBe(1);
  });

  test("preserves existing openspec schema profile metadata", () => {
    const existing: FrameworkConfig = {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [{ name: "openspec", schemaProfile: "mate-v1" }],
    };

    const merged = mergeWithDefaults(existing);

    expect(merged.capabilities).toContainEqual({
      name: "openspec",
      schemaProfile: "mate-v1",
    });
  });

  test("does not resurrect a default-selected capability the user deliberately deselected", () => {
    const existing: FrameworkConfig = {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [{ name: "tokensave" }],
    };

    const merged = mergeWithDefaults(existing);

    expect(merged.capabilities?.map((c) => c.name)).toEqual(["tokensave"]);
  });

  test("preserves existing unknown capabilities", () => {
    const existing: FrameworkConfig = {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [{ name: "custom-cap" }],
    };

    const merged = mergeWithDefaults(existing);

    expect(merged.capabilities?.map((c) => c.name)).toContain("custom-cap");
  });

  test("preserves all other fields from existing config", () => {
    const existing: FrameworkConfig = {
      profiles: { custom: { name: "custom", allowedAgents: ["opencode"] } },
    };

    const merged = mergeWithDefaults(existing);

    expect(merged.profiles).toEqual(existing.profiles);
  });

  test("preserves existing packageManagers when present and defaults to bun and uv otherwise", () => {
    expect(
      mergeWithDefaults({
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        packageManagers: ["bun", "uv"],
      }).packageManagers,
    ).toEqual(["bun", "uv"]);

    expect(
      mergeWithDefaults({
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      }).packageManagers,
    ).toEqual(["bun", "uv"]);
  });
});

describe("ConfigStore", () => {
  test("creates and returns default config when file is missing", async () => {
    const root = await makeTempDir("config-store-");
    const configPath = path.join(root, "framework.yaml");
    const store = new ConfigStore(configPath);

    const config = await store.load();

    expect(config.profiles.default).toBeDefined();
    expect(config.profiles.default.allowedAgents).toContain("claude");
    expect(config.packageManagers).toEqual(["bun", "uv"]);
    await fs.access(configPath);
  });

  test("does not rewrite file when loading a normal config", async () => {
    const root = await makeTempDir("config-store-migrate-");
    const configPath = path.join(root, "framework.yaml");
    const original =
      "profiles:\n  default:\n    name: default\n    allowedAgents:\n      - claude\n";
    await fs.writeFile(configPath, original, "utf8");
    const store = new ConfigStore(configPath);

    const config = await store.load();

    const afterLoad = await fs.readFile(configPath, "utf8");
    expect(afterLoad).toBe(original);
    expect(config.packageManagers).toEqual(["bun", "uv"]);
  });
});
