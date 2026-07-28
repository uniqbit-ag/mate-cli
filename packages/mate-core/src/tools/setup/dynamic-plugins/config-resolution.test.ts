import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  deepMergePluginConfig,
  interpolateEnvVars,
  readLocalPluginOverrides,
  resolveEffectivePluginConfig,
} from "./config-resolution";
import { pluginLocalOverridesPath } from "./paths";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("deepMergePluginConfig", () => {
  test("nested objects merge recursively", () => {
    expect(
      deepMergePluginConfig({ api: { url: "https://x", retries: 3 } }, { api: { retries: 5 } }),
    ).toEqual({ api: { url: "https://x", retries: 5 } });
  });

  test("arrays replace instead of concatenating", () => {
    expect(deepMergePluginConfig({ companions: ["a", "b"] }, { companions: ["c"] })).toEqual({
      companions: ["c"],
    });
  });

  test("scalars replace", () => {
    expect(deepMergePluginConfig({ token: "committed" }, { token: "local" })).toEqual({
      token: "local",
    });
  });

  test("missing override leaves committed config unchanged", () => {
    expect(deepMergePluginConfig({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  test("override without committed config is used as-is", () => {
    expect(deepMergePluginConfig(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("interpolateEnvVars", () => {
  test("replaces ${VAR} in string values recursively", () => {
    const result = interpolateEnvVars(
      { token: "${ACME_TOKEN}", nested: { urls: ["${ACME_URL}/v1"] } },
      { ACME_TOKEN: "secret", ACME_URL: "https://acme.example" },
    );
    expect(result).toEqual({
      value: { token: "secret", nested: { urls: ["https://acme.example/v1"] } },
      missing: [],
    });
  });

  test("unset variable is reported, never substituted empty", () => {
    const result = interpolateEnvVars({ token: "${ACME_TOKEN}" }, {});
    expect(result.missing).toEqual(["ACME_TOKEN"]);
  });

  test("non-string scalars pass through untouched", () => {
    const result = interpolateEnvVars({ retries: 3, on: true, off: null }, {});
    expect(result).toEqual({ value: { retries: 3, on: true, off: null }, missing: [] });
  });
});

describe("readLocalPluginOverrides", () => {
  test("returns overrides keyed by package name", async () => {
    const companionPath = await makeTempDir("plugin-overrides-");
    const overridesPath = pluginLocalOverridesPath(companionPath);
    await fs.mkdir(path.dirname(overridesPath), { recursive: true });
    await fs.writeFile(
      overridesPath,
      'plugins:\n  "@acme/custom-plugin":\n    api:\n      retries: 5\n',
      "utf8",
    );

    const overrides = await readLocalPluginOverrides(companionPath);
    expect(overrides["@acme/custom-plugin"]).toEqual({ api: { retries: 5 } });
  });

  test("missing file yields no overrides", async () => {
    const companionPath = await makeTempDir("plugin-overrides-none-");
    expect(await readLocalPluginOverrides(companionPath)).toEqual({});
  });
});

describe("resolveEffectivePluginConfig", () => {
  test("merges override over committed config then interpolates", async () => {
    const companionPath = await makeTempDir("plugin-effective-");
    const overridesPath = pluginLocalOverridesPath(companionPath);
    await fs.mkdir(path.dirname(overridesPath), { recursive: true });
    await fs.writeFile(
      overridesPath,
      'plugins:\n  "@acme/custom-plugin":\n    api:\n      retries: 5\n    extra: "${ACME_EXTRA}"\n',
      "utf8",
    );

    const result = await resolveEffectivePluginConfig(
      companionPath,
      {
        package: "@acme/custom-plugin",
        version: "1.0.0",
        config: { api: { url: "https://x", retries: 3 }, token: "${ACME_TOKEN}" },
      },
      { ACME_TOKEN: "secret", ACME_EXTRA: "local" },
    );

    expect(result).toEqual({
      ok: true,
      config: {
        api: { url: "https://x", retries: 5 },
        token: "secret",
        extra: "local",
      },
    });
  });

  test("unset variable produces an error naming the variable", async () => {
    const companionPath = await makeTempDir("plugin-effective-missing-");
    const result = await resolveEffectivePluginConfig(
      companionPath,
      { package: "@acme/custom-plugin", version: "1.0.0", config: { token: "${ACME_TOKEN}" } },
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingVariables).toEqual(["ACME_TOKEN"]);
  });

  test("no committed config and no override yields undefined config", async () => {
    const companionPath = await makeTempDir("plugin-effective-empty-");
    const result = await resolveEffectivePluginConfig(
      companionPath,
      { package: "@acme/custom-plugin", version: "1.0.0" },
      {},
    );
    expect(result).toEqual({ ok: true, config: undefined });
  });
});
