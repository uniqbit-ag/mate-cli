import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { LaunchPreflightError } from "../types";
import { getWrapperBinPath } from "../../package-paths";
import { ClaudeAdapter } from "./claude";
import { assertSupportedCodexVersion, CodexAdapter } from "./codex";
import { OpenCodeAdapter } from "./opencode";
import type { AdapterContext, ProxyDeps } from "./base";
import type { SpawnProxyOpts } from "../headroom/proxy";
import { getReactDoctorBinPath } from "../../package-paths";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function withPath<T>(value: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = value;
  try {
    return await fn();
  } finally {
    process.env.PATH = previous;
  }
}

async function withEnv<T>(
  name: string,
  value: string | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

function makeContext(capabilities: AdapterContext["capabilities"] = []): AdapterContext {
  return {
    repository: {
      id: "app",
      path: "/tmp/app",
      profile: "default",
    },
    policy: {
      allowedAgents: ["claude", "opencode"],
    },
    companionPath: "/tmp/companion",
    capabilities,
  };
}

describe("Codex launch integration", () => {
  test("requires Codex 0.145.0 or newer", () => {
    expect(() => assertSupportedCodexVersion("codex-cli 0.144.0")).toThrow(/codex update/);
    expect(() => assertSupportedCodexVersion("codex-cli 0.145.0")).not.toThrow();
  });

  test("injects guidance, companion access, and preserves passthrough arguments", async () => {
    const companionPath = await makeTempDir("mate-codex-companion-");
    await fs.writeFile(path.join(companionPath, "AGENTS.md"), "# Companion instructions\n", "utf8");
    const launch = await new CodexAdapter().prepareLaunch({ ...makeContext(), companionPath }, [
      "--sandbox",
      "danger-full-access",
      "prompt",
    ]);

    expect(launch.command).toBe("codex");
    expect(launch.args.filter((arg) => arg === "--add-dir")).toHaveLength(1);
    expect(launch.args).toContain(companionPath);
    expect(launch.args.join("\n")).toContain("Companion instructions");
    expect(launch.args.slice(-3)).toEqual(["--sandbox", "danger-full-access", "prompt"]);
  });

  test("does not duplicate a caller-supplied companion add-dir", () => {
    const adapter = new CodexAdapter();
    const args = adapter.buildArgs(makeContext(), ["--add-dir", "/tmp/companion"]);
    expect(args.filter((arg) => arg === "--add-dir")).toHaveLength(1);
  });

  test("adds launch-scoped TokenSave MCP configuration only when enabled", () => {
    const adapter = new CodexAdapter();
    expect(adapter.buildArgs(makeContext(), []).join(" ")).not.toContain("mcp_servers.tokensave");
    expect(adapter.buildArgs(makeContext([{ name: "tokensave" }]), []).join(" ")).toContain(
      "mcp_servers.tokensave.command",
    );
  });

  test.each([
    ["--config", 'developer_instructions="replacement"'],
    ['--config=developer_instructions="replacement"'],
    ["-c", 'developer_instructions="replacement"'],
    ['-c=mcp_servers.tokensave.command="replacement"'],
    ['--config=mcp_servers.tokensave={"command":"replacement"}'],
    ['--config="mcp_servers"."tokensave".command="replacement"'],
    ['--config=mcp_servers={"tokensave":{"command":"replacement"}}'],
  ])("rejects caller overrides of Mate-managed Codex config using %s", (...args) => {
    const adapter = new CodexAdapter();
    expect(() => adapter.buildArgs(makeContext([{ name: "tokensave" }]), args)).toThrow(
      /managed by Mate/,
    );
  });

  test("allows unrelated Codex config and caller TokenSave config when Mate does not own it", () => {
    const adapter = new CodexAdapter();
    expect(() =>
      adapter.buildArgs(makeContext(), [
        "--config",
        'model_reasoning_effort="high"',
        '--config=mcp_servers.tokensave.command="custom"',
      ]),
    ).not.toThrow();
  });

  test("does not interpret config-looking positional input after -- as an override", () => {
    const adapter = new CodexAdapter();
    expect(() =>
      adapter.buildArgs(makeContext([{ name: "tokensave" }]), [
        "exec",
        "--",
        "--config",
        'developer_instructions="example"',
      ]),
    ).not.toThrow();
  });

  test.each([
    ['[mcp_servers]\ntokensave = { command = "custom", args = ["serve"] }\n'],
    ['[mcp_servers."tokensave"]\ncommand = "custom"\nargs = ["serve"]\n'],
  ])("rejects conflicting project TokenSave TOML representations", async (config) => {
    const root = await makeTempDir("mate-codex-project-config-");
    const binDir = await makeTempDir("mate-codex-bin-");
    await fs.mkdir(path.join(root, ".codex"), { recursive: true });
    await fs.writeFile(path.join(root, ".codex", "config.toml"), config, "utf8");
    await fs.writeFile(
      path.join(binDir, "codex"),
      "#!/usr/bin/env bun\nconsole.log('codex-cli 0.145.0');\n",
      "utf8",
    );
    await fs.chmod(path.join(binDir, "codex"), 0o755);

    await withPath(binDir, async () => {
      await expect(
        new CodexAdapter().validateLaunch({
          ...makeContext([{ name: "tokensave" }]),
          repository: { ...makeContext().repository, path: root },
        }),
      ).rejects.toThrow(/conflicting TokenSave MCP server/);
    });
  });

  test("uses the native Headroom wrapper contract", async () => {
    const binDir = await makeTempDir("mate-codex-headroom-");
    await fs.writeFile(path.join(binDir, "headroom"), "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(path.join(binDir, "headroom"), 0o755);
    await withPath(binDir, async () => {
      const launch = await new CodexAdapter().prepareLaunch(makeContext([{ name: "headroom" }]), [
        "prompt",
      ]);
      expect(launch.command).toBe("headroom");
      expect(launch.args.slice(0, 5)).toEqual([
        "wrap",
        "codex",
        "--no-context-tool",
        "--",
        "--config",
      ]);
      expect(launch.env.HEADROOM_TELEMETRY).toBe("off");
      expect(launch.env.HEADROOM_OUTPUT_SHAPER).toBe("1");
    });
  });
});

async function writeOpenCodeRuntime(
  companionPath: string,
  guidance: {
    version?: number;
    companionGuidance?: string;
    codebaseExplorationGuidance?: string;
    errors?: string[];
  } = {
    version: 1,
    companionGuidance:
      '<companion-policy framework="mate" priority="mandatory"></companion-policy>',
    codebaseExplorationGuidance: "",
    errors: [],
  },
): Promise<void> {
  await fs.mkdir(path.join(companionPath, ".opencode", "plugins"), { recursive: true });
  await fs.writeFile(path.join(companionPath, ".opencode", "opencode.json"), "{}\n", "utf8");
  await fs.writeFile(
    path.join(companionPath, ".opencode", ".mate-guidance.json"),
    JSON.stringify(guidance, null, 2) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(companionPath, ".opencode", "plugins", "mate-add-dir.ts"),
    "export {};\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(companionPath, ".opencode", "plugins", "mate-companion.ts"),
    "export {};\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(companionPath, ".opencode", "plugins", "mate-companion-policy.ts"),
    "export {};\n",
    "utf8",
  );
}

function noProxyDeps(): ProxyDeps {
  return {
    isProxyReachable: mock(async () => false),
    spawnProxyBackground: mock(() => {}),
    waitForProxyReachable: mock(async () => true),
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("LaunchAdapter.prepareLaunch", () => {
  test("returns direct Claude invocation when headroom capability is disabled", async () => {
    const launch = await new ClaudeAdapter().prepareLaunch(makeContext(), ["--print", "hello"]);

    expect(launch.command).toBe("claude");
    expect(launch.args[0]).toBe("--add-dir");
    expect(launch.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("1");
    expect(launch.warning).toBeUndefined();
  });

  test("launches agent directly (not via headroom wrap) when proxy is not reachable", async () => {
    const binDir = await makeTempDir("mate-headroom-bin-");
    const headroomPath = path.join(binDir, "headroom");
    await fs.writeFile(headroomPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(headroomPath, 0o755);

    await withPath(binDir, async () => {
      const spawnMock = mock(() => {});
      const launch = await new OpenCodeAdapter().prepareLaunch(
        makeContext([{ name: "headroom" }]),
        ["--mode", "chat"],
        {
          isProxyReachable: async () => false,
          spawnProxyBackground: spawnMock,
          waitForProxyReachable: async () => true,
        },
      );

      expect(launch.command).toBe("opencode");
      expect(launch.args).not.toContain("wrap");
      expect(launch.args).toContain("--mode");
      expect(launch.args).toContain("chat");
      expect(launch.env.PATH).toBe(`${getWrapperBinPath()}${path.delimiter}${binDir}`);
      expect(launch.env.HEADROOM_MEMORY_DB_PATH).toBeUndefined();
      expect(launch.env.HEADROOM_MEMORY_PROJECT_ROOT).toBeUndefined();
      expect(launch.warning).toBeUndefined();
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledWith({ port: 8787 });
    });
  });

  test("skips proxy spawn when proxy is already reachable", async () => {
    const binDir = await makeTempDir("mate-headroom-bin-");
    const headroomPath = path.join(binDir, "headroom");
    await fs.writeFile(headroomPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(headroomPath, 0o755);

    await withPath(binDir, async () => {
      const spawnMock = mock(() => {});
      const launch = await new ClaudeAdapter().prepareLaunch(
        makeContext([{ name: "headroom" }]),
        ["--print", "hello"],
        { isProxyReachable: async () => true, spawnProxyBackground: spawnMock },
      );

      expect(launch.command).toBe("claude");
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  test("spawns the proxy with only the resolved port and no memory settings", async () => {
    const binDir = await makeTempDir("mate-headroom-bin-");
    const headroomPath = path.join(binDir, "headroom");
    await fs.writeFile(headroomPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(headroomPath, 0o755);

    await withPath(binDir, async () => {
      let capturedOpts: SpawnProxyOpts | null = null;
      const spawnMock = mock((opts: SpawnProxyOpts) => {
        capturedOpts = opts;
      });

      await new ClaudeAdapter().prepareLaunch(makeContext([{ name: "headroom" }]), [], {
        isProxyReachable: async () => false,
        spawnProxyBackground: spawnMock as unknown as (opts: SpawnProxyOpts) => void,
        waitForProxyReachable: async () => true,
      });

      expect(capturedOpts).toEqual({ port: 8787 });
    });
  });

  test("headroom binary not on PATH produces warning and launches agent directly", async () => {
    await withPath("", async () => {
      const launch = await new ClaudeAdapter().prepareLaunch(makeContext([{ name: "headroom" }]), [
        "--print",
        "hello",
      ]);

      expect(launch.command).toBe("claude");
      expect(launch.warning).toContain("headroom capability enabled");
      expect(launch.warning).toContain("`headroom` was not found on PATH");
      expect(launch.warning).toContain("launching claude directly");
    });
  });

  test("validates the required OpenCode companion plugin before launch", async () => {
    const companionPath = await makeTempDir("mate-opencode-companion-");
    await writeOpenCodeRuntime(companionPath);

    await expect(
      new OpenCodeAdapter().validateLaunch({ ...makeContext(), companionPath }),
    ).resolves.toBeUndefined();
  });

  test("fails OpenCode launch validation when the companion plugin is missing", async () => {
    const companionPath = await makeTempDir("mate-opencode-missing-");

    await expect(
      new OpenCodeAdapter().validateLaunch({ ...makeContext(), companionPath }),
    ).rejects.toThrow(LaunchPreflightError);
    await expect(
      new OpenCodeAdapter().validateLaunch({ ...makeContext(), companionPath }),
    ).rejects.toThrow(/OpenCode companion runtime is incomplete/);
  });

  test("fails OpenCode launch validation when plugin guidance was not injected", async () => {
    const companionPath = await makeTempDir("mate-opencode-placeholder-");
    await writeOpenCodeRuntime(companionPath, {
      version: 1,
      companionGuidance: "",
      codebaseExplorationGuidance: "",
      errors: [],
    });

    await expect(
      new OpenCodeAdapter().validateLaunch({ ...makeContext(), companionPath }),
    ).rejects.toThrow(/OpenCode companion runtime is invalid/);
    await expect(
      new OpenCodeAdapter().validateLaunch({ ...makeContext(), companionPath }),
    ).rejects.toThrow(/Missing injected companion guidance/);
  });

  test("fails OpenCode launch validation when enabled codebase guidance was not injected", async () => {
    const companionPath = await makeTempDir("mate-opencode-codebase-guidance-");
    await writeOpenCodeRuntime(companionPath, {
      version: 1,
      companionGuidance:
        '<companion-policy framework="mate" priority="mandatory"></companion-policy>',
      codebaseExplorationGuidance: "",
      errors: ["codebase exploration guidance was not injected"],
    });

    await expect(
      new OpenCodeAdapter().validateLaunch({
        ...makeContext([{ name: "tokensave" }]),
        companionPath,
      }),
    ).rejects.toThrow(/Missing injected codebase exploration guidance/);
    await expect(
      new OpenCodeAdapter().validateLaunch({
        ...makeContext([{ name: "tokensave" }]),
        companionPath,
      }),
    ).rejects.toThrow(/codebase exploration guidance was not injected/);
  });
});

describe("graphify GRAPHIFY_OUT env injection", () => {
  test("injects companion GRAPHIFY_OUT when graphify capability is enabled", async () => {
    const launch = await withEnv("GRAPHIFY_OUT", undefined, () =>
      new ClaudeAdapter().prepareLaunch(makeContext([{ name: "graphify" }]), []),
    );

    expect(launch.env.GRAPHIFY_OUT).toBe(
      path.join("/tmp/companion", ".graphify", "app", "graphify-out"),
    );
    expect(launch.env.MATE_GRAPHIFY_ENABLED).toBe("1");
  });

  test("does not set GRAPHIFY_OUT when graphify capability is absent", async () => {
    const launch = await withEnv("GRAPHIFY_OUT", undefined, () =>
      new ClaudeAdapter().prepareLaunch(makeContext(), []),
    );

    expect(launch.env.GRAPHIFY_OUT).toBeUndefined();
    expect(launch.env.MATE_GRAPHIFY_ENABLED).toBe("0");
  });
});

describe("react-doctor capability env injection", () => {
  test("marks react-doctor enabled only when the capability is selected", async () => {
    const enabled = await new ClaudeAdapter().prepareLaunch(
      makeContext([{ name: "react-doctor" }]),
      [],
    );
    const disabled = await new ClaudeAdapter().prepareLaunch(makeContext(), []);

    expect(enabled.env.MATE_REACT_DOCTOR_ENABLED).toBe("1");
    expect(enabled.env.MATE_REACT_DOCTOR_BIN_PATH).toBe(getReactDoctorBinPath());
    expect(getReactDoctorBinPath()).toMatch(/[\\/]react-doctor[\\/]bin[\\/]react-doctor\.js$/);
    await fs.access(getReactDoctorBinPath());
    expect(disabled.env.MATE_REACT_DOCTOR_ENABLED).toBe("0");
    expect(disabled.env.MATE_REACT_DOCTOR_BIN_PATH).toBeUndefined();
  });
});

describe("launch PATH injection", () => {
  test("prepends only the Mate wrapper dir when tokensave is enabled", async () => {
    const launch = await withEnv("PATH", "/usr/bin", () =>
      new ClaudeAdapter().prepareLaunch(makeContext([{ name: "tokensave" }]), []),
    );

    expect(launch.env.PATH).toBe(`${getWrapperBinPath()}${path.delimiter}/usr/bin`);
    expect(launch.env.PATH).not.toContain(".tokensave");
  });

  test("PATH is unchanged when tokensave capability is absent", async () => {
    const launch = await withEnv("PATH", "/usr/bin", () =>
      new ClaudeAdapter().prepareLaunch(makeContext(), []),
    );

    expect(launch.env.PATH).toBe(`${getWrapperBinPath()}${path.delimiter}/usr/bin`);
  });
});

describe("Claude companion settings launch flags", () => {
  test("adds --setting-sources and --settings when companion settings exist", async () => {
    const companionPath = await makeTempDir("mate-claude-settings-flags-");
    const settingsPath = path.join(companionPath, ".claude", "settings.local.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, "{}\n", "utf8");

    const launch = await new ClaudeAdapter().prepareLaunch({ ...makeContext(), companionPath }, [
      "--print",
      "hello",
    ]);

    expect(launch.args).toContain("--setting-sources");
    const sourcesIndex = launch.args.indexOf("--setting-sources");
    expect(launch.args[sourcesIndex + 1]).toBe("user,project,local");
    expect(launch.args).toContain("--settings");
    const settingsIndex = launch.args.indexOf("--settings");
    expect(launch.args[settingsIndex + 1]).toBe(settingsPath);
    // Passthrough args stay after the managed settings flags.
    expect(launch.args.slice(-2)).toEqual(["--print", "hello"]);
  });

  test("omits settings flags when companion settings file is absent", async () => {
    const companionPath = await makeTempDir("mate-claude-settings-none-");

    const launch = await new ClaudeAdapter().prepareLaunch({ ...makeContext(), companionPath }, []);

    expect(launch.args).not.toContain("--setting-sources");
    expect(launch.args).not.toContain("--settings");
    expect(launch.args).not.toContain("--mcp-config");
    expect(launch.args[0]).toBe("--add-dir");
  });

  test("adds --mcp-config when companion .mcp.json exists", async () => {
    const companionPath = await makeTempDir("mate-claude-mcp-flag-");
    const mcpConfigPath = path.join(companionPath, ".mcp.json");
    await fs.writeFile(mcpConfigPath, '{"mcpServers":{}}\n', "utf8");

    const launch = await new ClaudeAdapter().prepareLaunch({ ...makeContext(), companionPath }, [
      "--print",
      "hello",
    ]);

    expect(launch.args).toContain("--mcp-config");
    const mcpIndex = launch.args.indexOf("--mcp-config");
    expect(launch.args[mcpIndex + 1]).toBe(mcpConfigPath);
    // Passthrough args stay after the managed flags.
    expect(launch.args.slice(-2)).toEqual(["--print", "hello"]);
  });
});

describe("Adapter headroom env wiring", () => {
  async function launchWithHeadroom(
    adapter: InstanceType<typeof ClaudeAdapter | typeof OpenCodeAdapter>,
    extra: Record<string, unknown> = {},
  ) {
    const binDir = await makeTempDir("mate-headroom-bin-");
    const headroomPath = path.join(binDir, "headroom");
    await fs.writeFile(headroomPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(headroomPath, 0o755);

    return withPath(binDir, () =>
      adapter.prepareLaunch(
        { ...makeContext([{ name: "headroom" }]), ...extra },
        [],
        noProxyDeps(),
      ),
    );
  }

  test("ClaudeAdapter sets ANTHROPIC_BASE_URL when headroom cap is present", async () => {
    const launch = await withEnv("OPENAI_BASE_URL", undefined, () =>
      withEnv("OPENCODE_CONFIG_CONTENT", undefined, () => launchWithHeadroom(new ClaudeAdapter())),
    );

    expect(launch.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/app$/);
    expect(launch.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(launch.env.OPENAI_BASE_URL).toBeUndefined();
    expect(launch.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  test("ClaudeAdapter does not set ANTHROPIC_BASE_URL when headroom cap is absent", async () => {
    const launch = await withEnv("ANTHROPIC_BASE_URL", undefined, () =>
      new ClaudeAdapter().prepareLaunch(makeContext(), []),
    );

    expect(launch.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("OpenCodeAdapter injects the mate reference through OPENCODE_CONFIG_CONTENT", async () => {
    const launch = await withEnv("OPENCODE_CONFIG_CONTENT", undefined, () =>
      new OpenCodeAdapter().prepareLaunch(makeContext(), []),
    );

    expect(launch.env.OPENCODE_CONFIG_CONTENT).toBeDefined();
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.references.mate).toBe("/tmp/companion");
    expect(config.permission.external_directory["/tmp/companion"]).toBe("allow");
    expect(config.permission.external_directory["/tmp/companion/**"]).toBe("allow");
    expect(config.skills.paths).toEqual(["/tmp/companion/.agents/skills"]);
  });

  test("OpenCodeAdapter merges the mate reference and permissions with inherited OPENCODE_CONFIG_CONTENT", async () => {
    const launch = await withEnv(
      "OPENCODE_CONFIG_CONTENT",
      JSON.stringify({
        model: "anthropic/test",
        permission: { external_directory: { "../docs/**": "allow" } },
        references: { docs: "../docs" },
        skills: { paths: ["../team-skills"] },
      }),
      () => new OpenCodeAdapter().prepareLaunch(makeContext(), []),
    );

    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.permission.external_directory["../docs/**"]).toBe("allow");
    expect(config.permission.external_directory["/tmp/companion"]).toBe("allow");
    expect(config.permission.external_directory["/tmp/companion/**"]).toBe("allow");
    expect(config.references.docs).toBe("../docs");
    expect(config.references.mate).toBe("/tmp/companion");
    expect(config.skills.paths).toEqual(["../team-skills", "/tmp/companion/.agents/skills"]);
    expect(config.model).toBe("anthropic/test");
  });

  test("OpenCodeAdapter sets ANTHROPIC_BASE_URL, OPENAI_BASE_URL, and OPENCODE_CONFIG_CONTENT when headroom cap is present", async () => {
    const companionPath = await makeTempDir("mate-opencode-companion-");
    await fs.mkdir(path.join(companionPath, ".opencode", "plugins"), { recursive: true });
    await fs.writeFile(path.join(companionPath, ".opencode", "opencode.json"), "{}\n", "utf8");
    await fs.writeFile(
      path.join(companionPath, ".opencode", "plugins", "mate-add-dir.ts"),
      "export {};\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(companionPath, ".opencode", "plugins", "mate-companion.ts"),
      "export {};\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(companionPath, ".opencode", "plugins", "mate-companion-policy.ts"),
      "export {};\n",
      "utf8",
    );

    const launch = await launchWithHeadroom(new OpenCodeAdapter(), { companionPath });

    expect(launch.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/app$/);
    expect(launch.env.OPENAI_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/app\/v1$/);
    expect(launch.env.OPENCODE_CONFIG_CONTENT).toBeDefined();
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.references.mate).toBe(companionPath);
    expect(config.permission.external_directory[companionPath]).toBe("allow");
    expect(config.permission.external_directory[`${companionPath}/**`]).toBe("allow");
    expect(config.provider.anthropic.options.baseURL).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/p\/app$/,
    );
    expect(config.provider.openai.options.baseURL).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/p\/app\/v1$/,
    );
    expect(config.provider.anthropic.options.headers).toBeUndefined();
    expect(config.provider.openai.options.headers).toBeUndefined();
  });

  test("reuses the shared proxy across companion launches", async () => {
    const binDir = await makeTempDir("mate-headroom-bin-");
    const headroomPath = path.join(binDir, "headroom");
    await fs.writeFile(headroomPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(headroomPath, 0o755);

    await withPath(binDir, async () => {
      const reachability = mock(async () => reachability.mock.calls.length > 1);
      const spawnMock = mock(() => {});
      const waitMock = mock(async () => true);

      const firstLaunch = await new ClaudeAdapter().prepareLaunch(
        makeContext([{ name: "headroom" }]),
        ["--print", "hello"],
        {
          isProxyReachable: reachability,
          spawnProxyBackground: spawnMock,
          waitForProxyReachable: waitMock,
        },
      );

      const secondLaunch = await new ClaudeAdapter().prepareLaunch(
        { ...makeContext([{ name: "headroom" }]), companionPath: "/tmp/other-companion" },
        ["--print", "world"],
        {
          isProxyReachable: reachability,
          spawnProxyBackground: spawnMock,
          waitForProxyReachable: waitMock,
        },
      );

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(waitMock).toHaveBeenCalledTimes(1);
      expect(firstLaunch.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787/p/app");
      expect(secondLaunch.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787/p/app");
    });
  });

  test("does not inject headroom cwd headers per companion", async () => {
    const firstLaunch = await withEnv("ANTHROPIC_CUSTOM_HEADERS", undefined, () =>
      launchWithHeadroom(new ClaudeAdapter()),
    );
    const secondLaunch = await withEnv("ANTHROPIC_CUSTOM_HEADERS", undefined, () =>
      launchWithHeadroom(new ClaudeAdapter(), { companionPath: "/tmp/other-companion" }),
    );

    expect(firstLaunch.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(secondLaunch.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  test("OpenCodeAdapter does not set headroom env vars when headroom cap is absent", async () => {
    const launch = await withEnv("ANTHROPIC_BASE_URL", undefined, () =>
      withEnv("OPENAI_BASE_URL", undefined, () =>
        withEnv("OPENCODE_CONFIG_CONTENT", undefined, () =>
          new OpenCodeAdapter().prepareLaunch(makeContext(), []),
        ),
      ),
    );

    expect(launch.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(launch.env.OPENAI_BASE_URL).toBeUndefined();
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.references.mate).toBe("/tmp/companion");
    expect(config.permission.external_directory["/tmp/companion"]).toBe("allow");
    expect(config.permission.external_directory["/tmp/companion/**"]).toBe("allow");
  });

  test("waits for spawned headroom proxy before enabling Claude headroom env", async () => {
    const binDir = await makeTempDir("mate-headroom-bin-");
    const headroomPath = path.join(binDir, "headroom");
    await fs.writeFile(headroomPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(headroomPath, 0o755);

    await withPath(binDir, async () => {
      const spawnMock = mock(() => {});
      const waitMock = mock(async () => true);
      const launch = await new ClaudeAdapter().prepareLaunch(
        makeContext([{ name: "headroom" }]),
        ["--print", "hello"],
        {
          isProxyReachable: async () => false,
          spawnProxyBackground: spawnMock,
          waitForProxyReachable: waitMock,
        },
      );

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(waitMock).toHaveBeenCalledTimes(1);
      expect(launch.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/app$/);
      expect(launch.warning).toBeUndefined();
    });
  });

  test("retries headroom proxy startup up to three times before succeeding", async () => {
    const binDir = await makeTempDir("mate-headroom-bin-");
    const headroomPath = path.join(binDir, "headroom");
    await fs.writeFile(headroomPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(headroomPath, 0o755);

    await withPath(binDir, async () => {
      const spawnMock = mock(() => {});
      const waitMock = mock(async () => waitMock.mock.calls.length >= 3);
      const launch = await new ClaudeAdapter().prepareLaunch(
        makeContext([{ name: "headroom" }]),
        ["--print", "hello"],
        {
          isProxyReachable: async () => false,
          spawnProxyBackground: spawnMock,
          waitForProxyReachable: waitMock,
        },
      );

      expect(spawnMock).toHaveBeenCalledTimes(3);
      expect(waitMock).toHaveBeenCalledTimes(3);
      expect(launch.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/app$/);
      expect(launch.warning).toBeUndefined();
    });
  });

  test("falls back to direct Claude launch when spawned headroom proxy never becomes ready", async () => {
    const binDir = await makeTempDir("mate-headroom-bin-");
    const headroomPath = path.join(binDir, "headroom");
    await fs.writeFile(headroomPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(headroomPath, 0o755);

    await withEnv("ANTHROPIC_BASE_URL", undefined, () =>
      withPath(binDir, async () => {
        const spawnMock = mock(() => {});
        const waitMock = mock(async () => false);
        const launch = await new ClaudeAdapter().prepareLaunch(
          makeContext([{ name: "headroom" }]),
          ["--print", "hello"],
          {
            isProxyReachable: async () => false,
            spawnProxyBackground: spawnMock,
            waitForProxyReachable: waitMock,
          },
        );

        expect(spawnMock).toHaveBeenCalledTimes(3);
        expect(waitMock).toHaveBeenCalledTimes(3);
        expect(launch.command).toBe("claude");
        expect(launch.warning).toContain("headroom proxy failed to become ready");
        expect(launch.warning).toContain("after 3 attempts");
        expect(launch.env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(launch.env.PATH).toBe(`${getWrapperBinPath()}${path.delimiter}${binDir}`);
      }),
    );
  });
});
