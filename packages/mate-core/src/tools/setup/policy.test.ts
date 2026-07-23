import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createMate } from "../../create-mate";
import { resetActiveDistribution } from "../../distribution";
import { GlobalConfigStore } from "../../lib/orchestrator/global-config-store";
import { executeSetup } from "../setup";
import type { Plugin } from "./plugin";
import { getRequiredPluginIds, withRequiredSelections } from "./policy";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  resetActiveDistribution();
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makePlugin(id: string, kind: Plugin["kind"]): Plugin {
  return {
    id,
    kind,
    label: id,
    description: `${id} plugin`,
    defaultSelected: false,
    isEnabled: () => false,
    async apply() {},
    async teardown() {},
  };
}

const acmeConfig = {
  name: "mate",
  legacyNames: [],
  runtime: "bun",
  version: "1.0.0",
};

describe("getRequiredPluginIds", () => {
  test("returns the ids of required registration entries", () => {
    createMate({
      config: acmeConfig,
      plugins: [
        makePlugin("claude", "provider"),
        { plugin: makePlugin("acme-mcp", "capability"), policy: "required" },
        makePlugin("optional-cap", "capability"),
      ],
    });

    expect(getRequiredPluginIds()).toEqual(new Set(["bun", "uv", "acme-mcp"]));
  });
});

describe("withRequiredSelections", () => {
  test("adds required plugins to selections that omit them", () => {
    createMate({
      config: acmeConfig,
      plugins: [
        { plugin: makePlugin("locked-provider", "provider"), policy: "required" },
        { plugin: makePlugin("locked-pm", "packageManager"), policy: "required" },
        { plugin: makePlugin("acme-mcp", "capability"), policy: "required" },
      ],
    });

    const selections = withRequiredSelections({
      allowedAgents: ["claude"],
      packageManagers: ["bun"],
      capabilities: [{ name: "openspec" }],
      selectedOpenSpecSchema: "default",
      selectedGitMode: "default",
    });

    expect(selections.allowedAgents).toContain("locked-provider");
    expect(selections.allowedAgents).toContain("claude");
    expect(selections.packageManagers).toContain("locked-pm");
    expect(selections.capabilities.map((c) => c.name)).toEqual(["openspec", "acme-mcp"]);
  });

  test("does not duplicate required plugins already selected", () => {
    createMate({
      config: acmeConfig,
      plugins: [{ plugin: makePlugin("acme-mcp", "capability"), policy: "required" }],
    });

    const selections = withRequiredSelections({
      allowedAgents: [],
      packageManagers: [],
      capabilities: [{ name: "acme-mcp" }],
      selectedOpenSpecSchema: "default",
      selectedGitMode: "default",
    });

    expect(selections.capabilities.map((c) => c.name)).toEqual(["acme-mcp"]);
  });
});

describe("executeSetup with required plugins", () => {
  test("persists required capability even when explicit flags omit it", async () => {
    const companionRoot = await makeTempDir("mate-policy-setup-");
    const globalConfigStore = new GlobalConfigStore(
      path.join(companionRoot, "home", ".mate", "config.yaml"),
    );

    createMate({
      config: acmeConfig,
      plugins: [
        makePlugin("claude", "provider"),
        { plugin: makePlugin("acme-mcp", "capability"), policy: "required" },
      ],
    });

    const { config } = await executeSetup(
      {
        allowedAgents: ["claude"],
        capabilities: [{ name: "openspec" }],
      },
      { cwd: companionRoot, globalConfigStore },
    );

    expect(config.capabilities?.map((c) => c.name)).toContain("openspec");
    expect(config.capabilities?.map((c) => c.name)).toContain("acme-mcp");

    const saved = await fs.readFile(
      path.join(companionRoot, ".mate", "config", "framework.yaml"),
      "utf8",
    );
    expect(saved).toContain("acme-mcp");
  });
});
