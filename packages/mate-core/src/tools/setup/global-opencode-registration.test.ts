import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { registerMateOpenCodePluginGlobally } from "./global-opencode-registration";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("registerMateOpenCodePluginGlobally", () => {
  test("adds the pinned plugin reference while preserving user config", async () => {
    const root = await makeTempDir("mate-opencode-global-reg-");
    const configPath = path.join(root, "opencode", "opencode.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ theme: "dark", plugin: ["user-plugin"] }),
      "utf8",
    );

    await registerMateOpenCodePluginGlobally({
      configPath,
      pluginReference: "@uniqbit/mate-opencode-plugin@1.2.3",
    });

    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.plugin).toEqual(["user-plugin", "@uniqbit/mate-opencode-plugin@1.2.3"]);
  });

  test("registers the reference in the sibling tui.json for TUI plugin loading", async () => {
    const root = await makeTempDir("mate-opencode-global-reg-tui-");
    const configPath = path.join(root, "opencode", "opencode.json");
    const tuiConfigPath = path.join(root, "opencode", "tui.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(tuiConfigPath, JSON.stringify({ plugin: ["user-tui-plugin"] }), "utf8");

    await registerMateOpenCodePluginGlobally({
      configPath,
      pluginReference: "@uniqbit/mate-opencode-plugin@1.2.3",
    });

    const tuiConfig = JSON.parse(await fs.readFile(tuiConfigPath, "utf8"));
    expect(tuiConfig.plugin).toEqual(["user-tui-plugin", "@uniqbit/mate-opencode-plugin@1.2.3"]);
  });

  test("replaces stale mate references and stays idempotent", async () => {
    const root = await makeTempDir("mate-opencode-global-reg-stale-");
    const configPath = path.join(root, "opencode.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ plugin: ["@uniqbit/mate-opencode-plugin@0.0.1", "user-plugin"] }),
      "utf8",
    );

    const deps = { configPath, pluginReference: "@uniqbit/mate-opencode-plugin@1.2.3" };
    await registerMateOpenCodePluginGlobally(deps);
    const first = await fs.readFile(configPath, "utf8");
    await registerMateOpenCodePluginGlobally(deps);
    const second = await fs.readFile(configPath, "utf8");

    expect(JSON.parse(first).plugin).toEqual([
      "user-plugin",
      "@uniqbit/mate-opencode-plugin@1.2.3",
    ]);
    expect(second).toBe(first);
  });
});
