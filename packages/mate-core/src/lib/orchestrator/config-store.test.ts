import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { ConfigStore, defaultConfig, mergeWithDefaults } from "./config-store";
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
    await fs.writeFile(configPath, "allowedAgents:\n  - claude\n", "utf8");

    const config = await new ConfigStore(configPath).load();
    expect(config.engines).toBeUndefined();
    expect(config.allowedAgents).toEqual(["claude"]);
  });

  test("framework.yaml with engines.mate parses into config", async () => {
    const root = await makeTempDir("config-store-engines-mate-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(configPath, "allowedAgents: []\nengines:\n  mate: '>=0.15.0'\n", "utf8");

    const config = await new ConfigStore(configPath).load();
    expect(config.engines?.mate).toBe(">=0.15.0");
  });

  test("framework.yaml with a custom distribution engines key parses into config", async () => {
    const root = await makeTempDir("config-store-engines-custom-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(configPath, "allowedAgents: []\nengines:\n  acme-mate: '>=1.2.0'\n", "utf8");

    const config = await new ConfigStore(configPath).load();
    expect(config.engines?.["acme-mate"]).toBe(">=1.2.0");
  });
});

describe("studio.terminal.agent parsing", () => {
  test.each([
    {
      name: "a name",
      yaml: "studio:\n  terminal:\n    agent: acme-analyst\n",
      agent: "acme-analyst",
    },
    { name: "no key", yaml: "", agent: undefined },
    { name: "an unrelated studio key", yaml: "studio:\n  other: 1\n", agent: undefined },
  ])("loads $name", async ({ yaml, agent }) => {
    const root = await makeTempDir("config-store-studio-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(configPath, `allowedAgents: []\n${yaml}`, "utf8");

    const config = await new ConfigStore(configPath).load();
    expect(config.studio?.terminal?.agent).toBe(agent);
  });
});

describe("hub manifest parsing", () => {
  test("loads Git source provenance and materialized commit", async () => {
    const root = await makeTempDir("config-store-hub-git-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(
      configPath,
      [
        "type: hub",
        "hub:",
        "  companions:",
        "    - id: product",
        "      path: companions/product",
        "      source:",
        "        kind: git",
        "        url: https://example.test/product.git",
        "        ref: main",
        "      materializedCommit: abc123",
        "allowedAgents: []",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = await new ConfigStore(configPath).load();

    expect(config.type).toBe("hub");
    expect(config.hub?.companions[0]).toEqual({
      id: "product",
      path: "companions/product",
      source: { kind: "git", url: "https://example.test/product.git", ref: "main" },
      materializedCommit: "abc123",
    });
  });

  test("rejects a Git member without a materialized commit", async () => {
    const root = await makeTempDir("config-store-hub-missing-commit-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(
      configPath,
      "type: hub\nhub:\n  companions:\n    - id: product\n      path: product\n      source:\n        kind: git\n        url: https://example.test/product.git\nallowedAgents: []\n",
      "utf8",
    );

    await expect(new ConfigStore(configPath).load()).rejects.toThrow(/materializedCommit/);
  });
});

describe("mergeWithDefaults", () => {
  test("adds default capabilities when existing config has none", () => {
    const existing: FrameworkConfig = {
      allowedAgents: ["claude"],
    };

    const merged = mergeWithDefaults(existing);

    const names = merged.capabilities?.map((c) => c.name);
    expect(names).toContain("react-doctor");
    expect(names).toContain("openspec");
  });

  test("does not duplicate capabilities already present", () => {
    const existing: FrameworkConfig = {
      allowedAgents: ["claude"],
      capabilities: [{ name: "react-doctor" }],
    };

    const merged = mergeWithDefaults(existing);

    const count = merged.capabilities?.filter((c) => c.name === "react-doctor").length;
    expect(count).toBe(1);
  });

  test("preserves existing openspec schema profile metadata", () => {
    const existing: FrameworkConfig = {
      allowedAgents: ["claude"],
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
      allowedAgents: ["claude"],
      capabilities: [{ name: "tokensave" }],
    };

    const merged = mergeWithDefaults(existing);

    expect(merged.capabilities?.map((c) => c.name)).toEqual(["tokensave"]);
  });

  test("preserves existing unknown capabilities", () => {
    const existing: FrameworkConfig = {
      allowedAgents: ["claude"],
      capabilities: [{ name: "custom-cap" }],
    };

    const merged = mergeWithDefaults(existing);

    expect(merged.capabilities?.map((c) => c.name)).toContain("custom-cap");
  });

  test("preserves all other fields from existing config", () => {
    const existing: FrameworkConfig = {
      allowedAgents: ["opencode"],
    };

    const merged = mergeWithDefaults(existing);

    expect(merged.allowedAgents).toEqual(existing.allowedAgents);
  });

  test("preserves existing packageManagers when present and defaults to bun and uv otherwise", () => {
    expect(
      mergeWithDefaults({
        allowedAgents: ["claude"],
        packageManagers: ["bun", "uv"],
      }).packageManagers,
    ).toEqual(["bun", "uv"]);

    expect(
      mergeWithDefaults({
        allowedAgents: ["claude"],
      }).packageManagers,
    ).toEqual(["bun", "uv"]);
  });
});

describe("plugins parsing", () => {
  test("framework.yaml with a plugins entry preserves it verbatim", async () => {
    const root = await makeTempDir("config-store-plugins-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(
      configPath,
      [
        "allowedAgents: []",
        "plugins:",
        '  - package: "@acme/custom-plugin"',
        '    version: "^1.0.0"',
        "    config:",
        "      companions:",
        "        - git: git@acme.example:foo-companion.git",
        "      token: ${ACME_TOKEN}",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = await new ConfigStore(configPath).load();
    expect(config.plugins).toEqual([
      {
        package: "@acme/custom-plugin",
        version: "^1.0.0",
        config: {
          companions: [{ git: "git@acme.example:foo-companion.git" }],
          token: "${ACME_TOKEN}",
        },
      },
    ]);
  });

  test("framework.yaml without plugins loads with plugins undefined", async () => {
    const root = await makeTempDir("config-store-plugins-none-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(configPath, "allowedAgents: []\n", "utf8");

    const config = await new ConfigStore(configPath).load();
    expect(config.plugins).toBeUndefined();
  });

  test("plugins entry with policy required is rejected", async () => {
    const root = await makeTempDir("config-store-plugins-required-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(
      configPath,
      [
        "allowedAgents: []",
        "plugins:",
        '  - package: "@acme/custom-plugin"',
        '    version: "1.0.0"',
        "    policy: required",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(new ConfigStore(configPath).load()).rejects.toThrow(
      /"@acme\/custom-plugin".*required.*(default|optional)/,
    );
  });

  test("plugins entry with an optional or default policy is accepted", async () => {
    const root = await makeTempDir("config-store-plugins-policy-ok-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(
      configPath,
      [
        "allowedAgents: []",
        "plugins:",
        '  - package: "@acme/a"',
        '    version: "1.0.0"',
        "    policy: default",
        '  - package: "@acme/b"',
        "    version: latest",
        "    policy: optional",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = await new ConfigStore(configPath).load();
    expect(config.plugins?.map((plugin) => plugin.policy)).toEqual(["default", "optional"]);
  });
});

describe("audiences parsing", () => {
  async function loadYaml(prefix: string, lines: string[]): Promise<FrameworkConfig> {
    const root = await makeTempDir(prefix);
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(configPath, ["allowedAgents: []", ...lines, ""].join("\n"), "utf8");
    return new ConfigStore(configPath).load();
  }

  test("an audience adds plugins and a default agent", async () => {
    const config = await loadYaml("config-store-audiences-ok-", [
      "audiences:",
      "  ba:",
      "    plugins:",
      '      - package: "@acme/analyst"',
      '        version: "1.0.0"',
      "        policy: default",
      "    studio:",
      "      terminal:",
      "        agent: business-analyst",
    ]);

    expect(config.audiences?.ba?.plugins).toEqual([
      { package: "@acme/analyst", version: "1.0.0", policy: "default" },
    ]);
    expect(config.audiences?.ba?.studio?.terminal?.agent).toBe("business-analyst");
  });

  test("no audiences key leaves audiences undefined", async () => {
    const config = await loadYaml("config-store-audiences-none-", []);
    expect(config.audiences).toBeUndefined();
  });

  test("the audiences block survives load and save verbatim", async () => {
    const root = await makeTempDir("config-store-audiences-roundtrip-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(
      configPath,
      [
        "allowedAgents: []",
        "plugins:",
        '  - package: "@acme/base"',
        '    version: "1.0.0"',
        "audiences:",
        "  ba:",
        "    plugins:",
        '      - package: "@acme/analyst"',
        '        version: "1.0.0"',
        "    studio:",
        "      terminal:",
        "        agent: business-analyst",
        "",
      ].join("\n"),
      "utf8",
    );

    const store = new ConfigStore(configPath);
    const loaded = await store.load();
    await store.save(loaded);
    const reloaded = await store.load();

    expect(reloaded.audiences).toEqual(loaded.audiences);
    expect(reloaded.plugins).toEqual([{ package: "@acme/base", version: "1.0.0" }]);
    expect(await fs.readFile(configPath, "utf8")).toContain("audiences:");
  });

  test("legacy profiles migration leaves audiences untouched", async () => {
    const config = await loadYaml("config-store-audiences-profiles-", [
      "profiles:",
      "  default:",
      "    allowedAgents:",
      "      - claude",
      "audiences:",
      "  ba:",
      "    studio:",
      "      terminal:",
      "        agent: business-analyst",
    ]);

    expect(config.audiences?.ba?.studio?.terminal?.agent).toBe("business-analyst");
  });

  test.each([
    {
      name: "a non-mapping audiences value",
      lines: ["audiences:", "  - ba"],
      error: /audiences.*mapping/,
    },
    {
      name: "an unsafe audience name",
      lines: ["audiences:", '  "BA Team":', "    plugins: []"],
      error: /audience name "BA Team"/,
    },
    {
      name: "a non-mapping audience",
      lines: ["audiences:", "  ba: nope"],
      error: /audience "ba".*mapping/,
    },
    {
      name: "an unknown audience key",
      lines: ["audiences:", "  ba:", "    plugin: []"],
      error: /audience "ba".*"plugin"/,
    },
    {
      name: "a non-array plugins value",
      lines: ["audiences:", "  ba:", "    plugins: nope"],
      error: /audience "ba".*plugins/,
    },
    {
      name: "a malformed plugin entry",
      lines: ["audiences:", "  ba:", "    plugins:", "      - package: 1"],
      error: /audience "ba".*plugins/,
    },
    {
      name: "a disallowed plugin policy",
      lines: [
        "audiences:",
        "  ba:",
        "    plugins:",
        '      - package: "@acme/analyst"',
        '        version: "1.0.0"',
        "        policy: required",
      ],
      error: /audience "ba".*"@acme\/analyst".*required/,
    },
    {
      name: "a non-string studio agent",
      lines: ["audiences:", "  ba:", "    studio:", "      terminal:", "        agent: 7"],
      error: /audience "ba".*studio\.terminal\.agent/,
    },
  ])("rejects $name", async ({ lines, error }) => {
    await expect(loadYaml("config-store-audiences-bad-", lines)).rejects.toThrow(error);
  });

  test("rejects a package declared in base and an audience", async () => {
    await expect(
      loadYaml("config-store-audiences-dup-base-", [
        "plugins:",
        '  - package: "@acme/analyst"',
        '    version: "1.0.0"',
        "audiences:",
        "  ba:",
        "    plugins:",
        '      - package: "@acme/analyst"',
        '        version: "1.0.0"',
      ]),
    ).rejects.toThrow(/"ba".*"@acme\/analyst"/);
  });

  test("rejects a package declared twice in one audience", async () => {
    await expect(
      loadYaml("config-store-audiences-dup-self-", [
        "audiences:",
        "  ba:",
        "    plugins:",
        '      - package: "@acme/analyst"',
        '        version: "1.0.0"',
        '      - package: "@acme/analyst"',
        '        version: "1.0.0"',
      ]),
    ).rejects.toThrow(/"ba".*"@acme\/analyst"/);
  });

  test("allows one package in two audiences at the same version", async () => {
    const config = await loadYaml("config-store-audiences-shared-", [
      "audiences:",
      "  ba:",
      "    plugins:",
      '      - package: "@acme/analyst"',
      '        version: "1.0.0"',
      "        config:",
      "          mode: ba",
      "  qa:",
      "    plugins:",
      '      - package: "@acme/analyst"',
      '        version: "1.0.0"',
      "        config:",
      "          mode: qa",
    ]);

    expect(Object.keys(config.audiences ?? {})).toEqual(["ba", "qa"]);
  });

  test("rejects one package at different versions in two audiences", async () => {
    await expect(
      loadYaml("config-store-audiences-version-", [
        "audiences:",
        "  ba:",
        "    plugins:",
        '      - package: "@acme/analyst"',
        '        version: "1.0.0"',
        "  qa:",
        "    plugins:",
        '      - package: "@acme/analyst"',
        '        version: "2.0.0"',
      ]),
    ).rejects.toThrow(/"@acme\/analyst".*"ba".*"qa"/);
  });

  test("rejects audiences on a hub root", async () => {
    await expect(
      loadYaml("config-store-audiences-hub-", [
        "type: hub",
        "hub:",
        "  companions: []",
        "audiences:",
        "  ba:",
        "    plugins: []",
      ]),
    ).rejects.toThrow(/only companions may declare audiences/i);
  });
});

describe("legacy profiles migration", () => {
  test("collapses profiles.default.allowedAgents into flat allowedAgents on load", async () => {
    const root = await makeTempDir("config-store-legacy-profiles-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(
      configPath,
      // prettier-ignore
      "profiles:" + "\n  default:\n    name: default\n    allowedAgents:\n      - claude\n      - opencode\n",
      "utf8",
    );

    const config = await new ConfigStore(configPath).load();

    expect(config.allowedAgents).toEqual(["claude", "opencode"]);
    expect((config as Record<string, unknown>).profiles).toBeUndefined();
  });

  test("legacy config without a default profile migrates to an empty list", async () => {
    const root = await makeTempDir("config-store-legacy-no-default-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(
      configPath,
      "profiles:\n  strict:\n    name: strict\n    allowedAgents:\n      - claude\n",
      "utf8",
    );

    const config = await new ConfigStore(configPath).load();

    expect(config.allowedAgents).toEqual([]);
  });

  test("saving after load persists the new shape without a profiles key", async () => {
    const root = await makeTempDir("config-store-legacy-rewrite-");
    const configPath = path.join(root, "framework.yaml");
    await fs.writeFile(
      configPath,
      // prettier-ignore
      "profiles:" + "\n  default:\n    name: default\n    allowedAgents:\n      - claude\n",
      "utf8",
    );

    const store = new ConfigStore(configPath);
    await store.save(await store.load());

    const written = await fs.readFile(configPath, "utf8");
    expect(written).not.toContain("profiles:");
    expect(written).toContain("allowedAgents:");
  });
});

describe("ConfigStore", () => {
  test("creates and returns default config when file is missing", async () => {
    const root = await makeTempDir("config-store-");
    const configPath = path.join(root, "framework.yaml");
    const store = new ConfigStore(configPath);

    const config = await store.load();

    expect(config.allowedAgents).toContain("claude");
    expect(config.packageManagers).toEqual(["bun", "uv"]);
    await fs.access(configPath);
  });

  test("loading an existing configuration leaves the file byte-identical", async () => {
    const root = await makeTempDir("config-store-pure-read-");
    const configPath = path.join(root, "framework.yaml");
    const original = "allowedAgents:\n  - claude\n";
    await fs.writeFile(configPath, original, "utf8");
    const store = new ConfigStore(configPath);

    const config = await store.load();

    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(config.capabilities).not.toContainEqual({ name: "rtk" });
    expect(config.packageManagers).toEqual(["bun", "uv"]);
  });

  test("repeated loads persist nothing and agree with one another", async () => {
    const root = await makeTempDir("config-store-idempotent-read-");
    const configPath = path.join(root, "framework.yaml");
    const original = "allowedAgents:\n  - claude\ncapabilities:\n  - name: rtk\n";
    await fs.writeFile(configPath, original, "utf8");
    const store = new ConfigStore(configPath);

    const first = await store.load();
    const second = await store.load();

    expect(second).toEqual(first);
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
  });

  test("a missing configuration is created from unmodified defaults", async () => {
    const root = await makeTempDir("config-store-missing-defaults-");
    const configPath = path.join(root, "framework.yaml");
    const store = new ConfigStore(configPath);

    const config = await store.load();

    expect(config).toEqual(defaultConfig());
    const persisted = await new ConfigStore(configPath).load();
    expect(persisted.capabilities).toEqual(defaultConfig().capabilities);
  });

  test("an unrecognized capability name survives a load untouched", async () => {
    const root = await makeTempDir("config-store-unknown-capability-");
    const configPath = path.join(root, "framework.yaml");
    const original = "allowedAgents: []\ncapabilities:\n  - name: retired-capability\n";
    await fs.writeFile(configPath, original, "utf8");
    const store = new ConfigStore(configPath);

    const config = await store.load();

    expect(config.capabilities?.map((capability) => capability.name)).toEqual([
      "retired-capability",
    ]);
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
  });

  test("a persisted migrations list round-trips unchanged and none is appended", async () => {
    const root = await makeTempDir("config-store-migrations-slot-");
    const configPath = path.join(root, "framework.yaml");
    const store = new ConfigStore(configPath);
    await store.save({
      allowedAgents: [],
      capabilities: [],
      migrations: ["rtk-capability-split-v1"],
    });

    const config = await store.load();
    expect(config.migrations).toEqual(["rtk-capability-split-v1"]);

    await store.save(config);
    expect(await fs.readFile(configPath, "utf8")).toContain("- rtk-capability-split-v1");

    const bare = path.join(root, "bare.yaml");
    await fs.writeFile(bare, "allowedAgents: []\ncapabilities: []\n", "utf8");
    const bareConfig = await new ConfigStore(bare).load();
    expect(bareConfig.migrations).toBeUndefined();
    expect(await fs.readFile(bare, "utf8")).not.toContain("migrations");
  });
});
