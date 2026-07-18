import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { frameworkConfig } from "../../framework";
import type { CapabilityPlugin, Plugin, SetupContext } from "./plugin";
import { PluginRegistry } from "./registry";
import { createGitignorePlugin } from "./plugins/gitignore";
import { applySetupCompatibilities } from "../setup";
import { claudePlugin } from "./providers/claude";
import { createHeadroomPlugin } from "./capabilities/headroom";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makePlugin(id: string, kind: Plugin["kind"] = "provider"): Plugin {
  return {
    id,
    kind,
    label: id,
    description: "",
    defaultSelected: false,
    isEnabled: () => true,
    async apply() {},
    async teardown() {},
  };
}

function makeProvider(id: string): Plugin {
  return {
    ...makePlugin(id, "provider"),
    isEnabled: (config) => (config.profiles.default?.allowedAgents ?? []).includes(id),
  };
}

describe("PluginRegistry", () => {
  test("register() appends plugin and getAll() returns it", () => {
    const reg = new PluginRegistry([]);
    const plugin = makePlugin("test-a");
    reg.register(plugin);
    expect(reg.getAll().find((p) => p.id === "test-a")).toBe(plugin);
  });

  test("chaining register() calls works", () => {
    const reg = new PluginRegistry([]);
    reg.register(makePlugin("a")).register(makePlugin("b"));
    const ids = reg.getAll().map((p) => p.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });

  test("getAll() returns a copy — mutations do not affect the registry", () => {
    const reg = new PluginRegistry([makePlugin("x")]);
    const first = reg.getAll();
    first.push(makePlugin("injected"));
    const second = reg.getAll();
    expect(second.find((p) => p.id === "injected")).toBeUndefined();
  });

  test("constructor pre-loads initial plugins", () => {
    const a = makePlugin("built-in-a");
    const b = makePlugin("built-in-b");
    const reg = new PluginRegistry([a, b]);
    const ids = reg.getAll().map((p) => p.id);
    expect(ids).toContain("built-in-a");
    expect(ids).toContain("built-in-b");
  });
});

describe("SetupContext — activeProviders", () => {
  test("activeProviders includes only providers where isEnabled returns true", async () => {
    const root = await makeTempDir("mate-ctx-providers-");
    const capturedCtx: SetupContext[] = [];

    const spyCapability: CapabilityPlugin = {
      id: "spy",
      kind: "capability",
      label: "Spy",
      description: "",
      defaultSelected: false,
      isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "spy"),
      async apply(ctx) {
        capturedCtx.push(ctx);
      },
      async teardown() {},
      forProvider: {
        claude: {
          async apply(ctx) {
            capturedCtx.push(ctx);
          },
          async teardown() {},
        },
      },
    };

    const plugins = [makeProvider("claude"), makeProvider("opencode"), spyCapability];
    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        capabilities: [{ name: "spy" }],
      },
      "setup",
      plugins,
    );

    expect(capturedCtx).toHaveLength(2);
    for (const ctx of capturedCtx) {
      expect(ctx.activeProviders).toEqual(["claude"]);
    }
  });

  test("engine computes activeProviders from enabled provider plugins", async () => {
    const root = await makeTempDir("mate-active-providers-");
    const headroomNoRtk = createHeadroomPlugin({ isRtkOnPath: () => false });
    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        capabilities: [],
      },
      "setup",
      [claudePlugin, headroomNoRtk],
    );
    // Verifies no crash — claude is active, others not
    await fs.access(path.join(root, ".claude")); // claude dir should exist
    await expect(fs.access(path.join(root, ".opencode"))).rejects.toThrow(); // opencode not active
  });
});

describe("GitignorePlugin", () => {
  function makeGitignorePlugin(plugins: Plugin[]) {
    return createGitignorePlugin(frameworkConfig.name, () => plugins);
  }

  test("active plugins contribute gitignore entries, inactive do not", async () => {
    const root = await makeTempDir("mate-gi-active-");
    await fs.writeFile(path.join(root, ".gitignore"), "", "utf8");

    const activePlugin: Plugin = {
      ...makePlugin("active"),
      isEnabled: () => true,
      gitignoreEntries: () => [".active/"],
    };
    const inactivePlugin: Plugin = {
      ...makePlugin("inactive"),
      isEnabled: () => false,
      gitignoreEntries: () => [".inactive/"],
    };

    const gitignorePlugin = makeGitignorePlugin([activePlugin, inactivePlugin]);
    const ctx: SetupContext = {
      companionPath: root,
      config: { profiles: { default: { name: "default", allowedAgents: [] } } },
      mode: "setup",
      activeProviders: [],
    };

    await gitignorePlugin.apply(ctx);

    const content = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(content).toContain(".active/");
    expect(content).not.toContain(".inactive/");
  });

  test("teardown removes managed block entirely", async () => {
    const root = await makeTempDir("mate-gi-teardown-");
    const start = `# ${frameworkConfig.name} managed: start`;
    const end = `# ${frameworkConfig.name} managed: end`;
    await fs.writeFile(
      path.join(root, ".gitignore"),
      `node_modules/\n\n${start}\n.venv/\n${end}\n`,
      "utf8",
    );

    const gitignorePlugin = makeGitignorePlugin([]);
    const ctx: SetupContext = {
      companionPath: root,
      config: { profiles: { default: { name: "default", allowedAgents: [] } } },
      mode: "sync",
      activeProviders: [],
    };

    await gitignorePlugin.teardown(ctx);

    const content = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(content).toBe("node_modules/\n");
    expect(content).not.toContain("managed:");
  });

  test("apply keeps sticky gitignore entries even when their plugin is disabled", async () => {
    const root = await makeTempDir("mate-gi-sticky-");
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");

    const stickyPlugin: Plugin = {
      ...makePlugin("sticky"),
      isEnabled: () => false,
      gitignoreEntries: () => [".sticky/"],
      persistGitignoreEntries: true,
    };

    const gitignorePlugin = makeGitignorePlugin([stickyPlugin]);
    const ctx: SetupContext = {
      companionPath: root,
      config: { profiles: { default: { name: "default", allowedAgents: [] } } },
      mode: "sync",
      activeProviders: [],
    };

    await gitignorePlugin.apply(ctx);

    const content = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(content).toContain(".sticky/");
  });

  test("apply is idempotent — running twice produces the same output", async () => {
    const root = await makeTempDir("mate-gi-idempotent-");
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");

    const plugin: Plugin = {
      ...makePlugin("uv"),
      kind: "packageManager",
      isEnabled: () => true,
      gitignoreEntries: () => [".venv/"],
    };
    const gitignorePlugin = makeGitignorePlugin([plugin]);
    const ctx: SetupContext = {
      companionPath: root,
      config: { profiles: { default: { name: "default", allowedAgents: [] } } },
      mode: "sync",
      activeProviders: [],
    };

    await gitignorePlugin.apply(ctx);
    const first = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    await gitignorePlugin.apply(ctx);
    const second = await fs.readFile(path.join(root, ".gitignore"), "utf8");

    expect(first).toBe(second);
  });
});

describe("engine forProvider cross-cutting", () => {
  test("forProvider.apply called when capability and provider both active", async () => {
    const root = await makeTempDir("mate-forprovider-apply-");
    const applyMock = mock(async () => {});
    const teardownMock = mock(async () => {});

    const capability: CapabilityPlugin = {
      id: "spy",
      kind: "capability",
      label: "Spy",
      description: "",
      defaultSelected: false,
      isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "spy"),
      async apply() {},
      async teardown() {},
      forProvider: {
        claude: {
          apply: applyMock,
          teardown: teardownMock,
        },
      },
    };

    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        capabilities: [{ name: "spy" }],
      },
      "setup",
      [makeProvider("claude"), capability],
    );

    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(teardownMock).not.toHaveBeenCalled();
  });

  test("forProvider.teardown called when capability disabled but provider active", async () => {
    const root = await makeTempDir("mate-forprovider-teardown-");
    const applyMock = mock(async () => {});
    const teardownMock = mock(async () => {});

    const capability: CapabilityPlugin = {
      id: "spy",
      kind: "capability",
      label: "Spy",
      description: "",
      defaultSelected: false,
      isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "spy"),
      async apply() {},
      async teardown() {},
      forProvider: {
        claude: {
          apply: applyMock,
          teardown: teardownMock,
        },
      },
    };

    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        capabilities: [{ name: "spy" }],
      },
      "setup",
      [makeProvider("claude"), capability],
    );

    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        capabilities: [],
      },
      "setup",
      [makeProvider("claude"), capability],
    );

    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(teardownMock).toHaveBeenCalledTimes(1);
  });

  test("forProvider.teardown called when provider is inactive", async () => {
    const root = await makeTempDir("mate-forprovider-skip-");

    const applyMock = mock(async () => {});
    const teardownMock = mock(async () => {});
    const capability: CapabilityPlugin = {
      id: "spy",
      kind: "capability",
      label: "Spy",
      description: "",
      defaultSelected: false,
      isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "spy"),
      async apply() {},
      async teardown() {},
      forProvider: {
        opencode: {
          apply: applyMock,
          teardown: teardownMock,
        },
      },
    };

    await applySetupCompatibilities(
      root,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        capabilities: [{ name: "spy" }],
      },
      "setup",
      [makeProvider("claude"), makeProvider("opencode"), capability],
    );

    expect(applyMock).not.toHaveBeenCalled();
    expect(teardownMock).toHaveBeenCalledTimes(1);
  });
});
