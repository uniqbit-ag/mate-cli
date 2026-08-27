import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createClaudePlugin,
  getCompanionClaudeMcpConfigPath,
  getCompanionClaudeSettingsPath,
  syncCompanionClaudeSettings,
} from "./claude";
import { getWrapperBinPath } from "../../../lib/package-paths";
import { createContextModePlugin } from "../capabilities/context-mode";
import { createGraphifyPlugin } from "../capabilities/graphify";
import { createOpenspecPlugin } from "../capabilities/openspec";
import { createReactDoctorPlugin } from "../capabilities/react-doctor";
import { createRtkPlugin } from "../capabilities/rtk";
import type { CapabilityContributionInput, CapabilityPlugin, SetupContext } from "../plugin";

const tempRoots: string[] = [];

// Contributions exactly as a capability declares them — the provider carries
// no per-capability knowledge for declared contributions anymore.
function declaredContributions(
  plugin: CapabilityPlugin,
  companionPath: string,
  enabled: boolean,
): CapabilityContributionInput[] {
  const ctx: SetupContext = {
    companionPath,
    config: {
      allowedAgents: ["claude"],
      capabilities: enabled ? [{ name: plugin.id }] : [],
    },
    mode: "setup",
    activeProviders: ["claude"],
  };
  return [
    {
      pluginId: plugin.id,
      enabled,
      contributions: plugin.getRuntimeContributions!(ctx).claude!,
    },
  ];
}

function reactDoctorContributions(
  companionPath: string,
  enabled: boolean,
): CapabilityContributionInput[] {
  return declaredContributions(createReactDoctorPlugin(), companionPath, enabled);
}

function openspecContributions(
  companionPath: string,
  enabled: boolean,
): CapabilityContributionInput[] {
  return declaredContributions(createOpenspecPlugin(), companionPath, enabled);
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function makeExecutable(dir: string, name: string): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(filePath, 0o755);
  return filePath;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

interface HookCommand {
  type: string;
  command: string;
  args?: string[];
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
}
interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  permissions?: { allow?: string[] } & Record<string, unknown>;
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
  autoMemoryEnabled?: boolean;
}

async function readCompanionSettings(companionPath: string): Promise<ClaudeSettings> {
  return JSON.parse(
    await fs.readFile(getCompanionClaudeSettingsPath(companionPath), "utf8"),
  ) as ClaudeSettings;
}

async function seedSettings(basePath: string, settings: ClaudeSettings): Promise<void> {
  const settingsPath = path.join(basePath, ".claude", "settings.local.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

function hasValidateHook(settings: ClaudeSettings, companionPath: string): boolean {
  return (settings.hooks?.PreToolUse ?? []).some((group) =>
    (group.hooks ?? []).some(
      (hook) => hook.command === `${companionPath}/.claude/hooks/validate-artifact-path`,
    ),
  );
}

function hasArtifactFinishHook(
  settings: ClaudeSettings,
  event: string,
  companionPath: string,
): boolean {
  return (settings.hooks?.[event] ?? []).some((group) =>
    (group.hooks ?? []).some(
      (hook) => hook.command === `sh "${companionPath}/.claude/hooks/mate-artifact-finish.sh"`,
    ),
  );
}

function hasPostToolHook(
  settings: ClaudeSettings,
  event: "PostToolUse" | "PostToolBatch",
  command: string,
): boolean {
  return (settings.hooks?.[event] ?? []).some((group) =>
    (group.hooks ?? []).some((hook) => hook.command === command),
  );
}

describe("syncCompanionClaudeSettings", () => {
  test("writes no mate hook groups by default (plugin-delivered)", async () => {
    const companionPath = await makeTempDir("mate-companion-basic-");
    await syncCompanionClaudeSettings(companionPath, {
      allowedAgents: ["claude"],
      capabilities: [],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.hooks).toBeUndefined();
  });

  test("disables auto memory by default", async () => {
    const companionPath = await makeTempDir("mate-companion-auto-memory-");
    await syncCompanionClaudeSettings(companionPath, {
      allowedAgents: ["claude"],
      capabilities: [],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.autoMemoryEnabled).toBe(false);
  });

  test("adds react-doctor post hook when capability enabled", async () => {
    const companionPath = await makeTempDir("mate-companion-react-doctor-");
    await syncCompanionClaudeSettings(
      companionPath,
      {
        allowedAgents: ["claude"],
        capabilities: [{ name: "react-doctor" }],
      },
      reactDoctorContributions(companionPath, true),
    );

    const settings = await readCompanionSettings(companionPath);
    expect(settings.hooks?.PostToolUse).toContainEqual({
      matcher: "Write|Edit|MultiEdit|NotebookEdit|ApplyPatch",
      hooks: [
        {
          type: "command",
          command: `sh "${companionPath}/.claude/hooks/react-doctor.sh"`,
          timeout: 5,
        },
      ],
    });
    expect(settings.hooks?.Stop).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: `sh "${companionPath}/.claude/hooks/react-doctor.sh"`,
            timeout: 45,
          },
        ],
      },
    ]);
  });

  test("does not write the openspec nudge hook even with git auto (plugin-delivered)", async () => {
    const companionPath = await makeTempDir("mate-companion-openspec-");
    await syncCompanionClaudeSettings(companionPath, {
      allowedAgents: ["claude"],
      git: "auto",
      capabilities: [{ name: "openspec" }],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(hasArtifactFinishHook(settings, "PostToolUse", companionPath)).toBe(false);
    expect(hasArtifactFinishHook(settings, "PreToolUse", companionPath)).toBe(false);
    expect(settings.hooks?.Stop).toBeUndefined();
  });

  test("does not register the openspec nudge hook when git auto mode is disabled", async () => {
    const companionPath = await makeTempDir("mate-companion-openspec-no-auto-");
    await syncCompanionClaudeSettings(companionPath, {
      allowedAgents: ["claude"],
      capabilities: [{ name: "openspec" }],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(hasArtifactFinishHook(settings, "PostToolUse", companionPath)).toBe(false);
    expect(hasArtifactFinishHook(settings, "PreToolUse", companionPath)).toBe(false);
  });

  test("resync strips stale mate-artifact-finish registrations and does not re-add them", async () => {
    const companionPath = await makeTempDir("mate-companion-openspec-migrate-");
    await seedSettings(companionPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `sh "${companionPath}/.claude/hooks/mate-artifact-finish.sh"`,
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `sh "${companionPath}/.claude/hooks/mate-artifact-finish.sh"`,
              },
            ],
          },
        ],
      },
    });

    await syncCompanionClaudeSettings(companionPath, {
      allowedAgents: ["claude"],
      git: "auto",
      capabilities: [{ name: "openspec" }],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(hasArtifactFinishHook(settings, "PreToolUse", companionPath)).toBe(false);
    expect(hasArtifactFinishHook(settings, "PostToolUse", companionPath)).toBe(false);
  });

  test("preserves an unmanaged hook and unmanaged permissions.allow entry", async () => {
    const companionPath = await makeTempDir("mate-companion-preserve-");
    await seedSettings(companionPath, {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo custom" }] }],
      },
      permissions: { allow: ["Bash(ls:*)"] },
    });

    await syncCompanionClaudeSettings(companionPath, {
      allowedAgents: ["claude"],
      capabilities: [],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.hooks?.PreToolUse).toContainEqual({
      matcher: "Bash",
      hooks: [{ type: "command", command: "echo custom" }],
    });
    expect(hasValidateHook(settings, companionPath)).toBe(false);
    expect(settings.permissions?.allow).toContain("Bash(ls:*)");
  });

  test("seeds Read and Edit companion permissions and never an ineffective Glob rule", async () => {
    const companionPath = await makeTempDir("mate-companion-permissions-");
    await syncCompanionClaudeSettings(companionPath, {
      allowedAgents: ["claude"],
      capabilities: [],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow).toContain(`Read(${companionPath}/**)`);
    expect(settings.permissions?.allow).toContain(`Edit(${companionPath}/**)`);
    expect(settings.permissions?.allow).not.toContain(`Glob(${companionPath}/**)`);
  });

  test("resync removes the legacy Glob companion permission entry", async () => {
    const companionPath = await makeTempDir("mate-companion-glob-migrate-");
    await seedSettings(companionPath, {
      permissions: {
        allow: ["Bash(ls:*)", `Read(${companionPath}/**)`, `Glob(${companionPath}/**)`],
      },
    });

    await syncCompanionClaudeSettings(companionPath, {
      allowedAgents: ["claude"],
      capabilities: [],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow).toContain("Bash(ls:*)");
    expect(settings.permissions?.allow).toContain(`Read(${companionPath}/**)`);
    expect(settings.permissions?.allow).toContain(`Edit(${companionPath}/**)`);
    expect(settings.permissions?.allow).not.toContain(`Glob(${companionPath}/**)`);
  });

  test("resync strips the legacy managed banner and preserves user-authored SessionStart hooks", async () => {
    const companionPath = await makeTempDir("mate-companion-session-start-");
    await seedSettings(companionPath, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: `${companionPath}/.claude/hooks/mate-session-banner` },
            ],
          },
          { hooks: [{ type: "command", command: "echo custom-session-start" }] },
        ],
      },
    });

    await syncCompanionClaudeSettings(companionPath, {
      allowedAgents: ["claude"],
      capabilities: [],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.hooks?.SessionStart).toEqual([
      { hooks: [{ type: "command", command: "echo custom-session-start" }] },
    ]);
  });

  test("applies declared tokensave hooks without duplication across repeated syncs", async () => {
    const companionPath = await makeTempDir("mate-companion-tokensave-");
    const binDir = await makeTempDir("mate-companion-bin-");
    const tokensavePath = await makeExecutable(binDir, "tokensave");

    await seedSettings(companionPath, {
      permissions: { allow: ["Bash(ls:*)"] },
    });

    const config = {
      allowedAgents: ["claude"],
      capabilities: [{ name: "tokensave" }],
    };
    // Contributions as the tokensave capability declares them; the provider
    // sync itself carries no tokensave knowledge anymore.
    const contributions = [
      {
        pluginId: "tokensave",
        enabled: true,
        contributions: {
          hookGroups: [
            {
              event: "PreToolUse",
              marker: "tokensave",
              group: {
                matcher: "Agent|Grep|Bash",
                hooks: [{ type: "command", command: tokensavePath, args: ["hook-pre-tool-use"] }],
              },
            },
            {
              event: "UserPromptSubmit",
              marker: "tokensave",
              group: {
                hooks: [{ type: "command", command: tokensavePath, args: ["hook-prompt-submit"] }],
              },
            },
            {
              event: "Stop",
              marker: "tokensave",
              group: { hooks: [{ type: "command", command: tokensavePath, args: ["hook-stop"] }] },
            },
          ],
          permissionEntries: ["mcp__tokensave__*"],
        },
      },
    ];

    await syncCompanionClaudeSettings(companionPath, config, contributions);
    await syncCompanionClaudeSettings(companionPath, config, contributions);

    const settings = await readCompanionSettings(companionPath);
    // MCP server lives in .mcp.json; settings.local.json must not carry it,
    // but the mcp__tokensave__* permission entry is still pre-seeded.
    expect(settings.permissions?.allow).toContain("Bash(ls:*)");
    expect(settings.permissions?.allow ?? []).toContain("mcp__tokensave__*");
    expect(settings.mcpServers?.tokensave).toBeUndefined();

    const mcpConfig = JSON.parse(
      await fs.readFile(getCompanionClaudeMcpConfigPath(companionPath), "utf8"),
    ) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
    expect(mcpConfig.mcpServers?.tokensave).toBeUndefined();

    expect(
      settings.hooks?.PreToolUse?.filter(
        (group) =>
          group.matcher === "Agent|Grep|Bash" &&
          group.hooks?.[0]?.command === tokensavePath &&
          group.hooks?.[0]?.args?.[0] === "hook-pre-tool-use",
      ),
    ).toHaveLength(1);
    expect(settings.hooks?.UserPromptSubmit).toContainEqual({
      hooks: [{ type: "command", command: tokensavePath, args: ["hook-prompt-submit"] }],
    });
    expect(settings.hooks?.Stop).toContainEqual({
      hooks: [{ type: "command", command: tokensavePath, args: ["hook-stop"] }],
    });
  });

  test("preserves an unmanaged .mcp.json server and prunes tokensave when disabled", async () => {
    const companionPath = await makeTempDir("mate-companion-mcp-prune-");
    const mcpConfigPath = getCompanionClaudeMcpConfigPath(companionPath);
    await fs.writeFile(
      mcpConfigPath,
      JSON.stringify({ mcpServers: { other: { command: "echo", args: ["ok"] } } }, null, 2),
      "utf8",
    );

    await syncCompanionClaudeSettings(companionPath, {
      allowedAgents: ["claude"],
      capabilities: [],
    });

    const mcpConfig = JSON.parse(await fs.readFile(mcpConfigPath, "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    expect(mcpConfig.mcpServers?.other).toEqual({ command: "echo", args: ["ok"] });
    expect(mcpConfig.mcpServers?.tokensave).toBeUndefined();
  });

  test("is idempotent across repeated syncs (no duplicate hooks or allow entries)", async () => {
    const companionPath = await makeTempDir("mate-companion-idempotent-");
    const config = {
      allowedAgents: ["claude"],
      git: "auto",
      capabilities: [{ name: "openspec" }, { name: "react-doctor" }],
    };

    await syncCompanionClaudeSettings(companionPath, config);
    const first = await fs.readFile(getCompanionClaudeSettingsPath(companionPath), "utf8");
    await syncCompanionClaudeSettings(companionPath, config);
    const second = await fs.readFile(getCompanionClaudeSettingsPath(companionPath), "utf8");

    expect(second).toBe(first);
  });

  test.each([
    [createRtkPlugin, "Bash(rtk:*)"],
    [createContextModePlugin, "Skill(context-mode:context-mode)"],
    [createContextModePlugin, "mcp__plugin_context-mode_context-mode__*"],
  ])("pre-seeds declared permission allowance %#: %s", async (factory, entry) => {
    const companionPath = await makeTempDir("mate-companion-perm-");
    const plugin = factory();
    await syncCompanionClaudeSettings(
      companionPath,
      {
        allowedAgents: ["claude"],
        capabilities: [{ name: plugin.id }],
      },
      declaredContributions(plugin, companionPath, true),
    );

    const settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow).toContain(entry);
  });

  test("pre-seeds declared react-doctor permission allowances", async () => {
    const companionPath = await makeTempDir("mate-companion-perm-declared-");
    await syncCompanionClaudeSettings(
      companionPath,
      { allowedAgents: ["claude"], capabilities: [{ name: "react-doctor" }] },
      reactDoctorContributions(companionPath, true),
    );

    const settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow).toContain("Bash(npx react-doctor:*)");
    expect(settings.permissions?.allow).toContain("Skill(react-doctor)");
  });

  test("pre-seeds declared openspec permission allowances", async () => {
    const companionPath = await makeTempDir("mate-companion-perm-openspec-");
    await syncCompanionClaudeSettings(
      companionPath,
      { allowedAgents: ["claude"], capabilities: [{ name: "openspec" }] },
      openspecContributions(companionPath, true),
    );

    const settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow).toContain("Bash(openspec:*)");
    expect(settings.permissions?.allow).toContain(
      `Bash(${path.join(getWrapperBinPath(), "openspec")}:*)`,
    );
  });

  test("pre-seeds package wrapper permission allowances", async () => {
    const companionPath = await makeTempDir("mate-companion-bin-perm-");
    await syncCompanionClaudeSettings(
      companionPath,
      {
        allowedAgents: ["claude"],
        capabilities: [{ name: "openspec" }, { name: "graphify" }],
      },
      [
        ...openspecContributions(companionPath, true),
        ...declaredContributions(createGraphifyPlugin(), companionPath, true),
      ],
    );

    const settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow).toContain(
      `Bash(${path.join(getWrapperBinPath(), "openspec")}:*)`,
    );
    expect(settings.permissions?.allow).toContain(
      `Bash(${path.join(getWrapperBinPath(), "graphify")}:*)`,
    );
  });

  test("removes obsolete companion wrapper permissions during reconciliation", async () => {
    const companionPath = await makeTempDir("mate-companion-legacy-bin-perm-");
    await seedSettings(companionPath, {
      permissions: {
        allow: [
          "Bash($MATE_COMPANION_BIN_PATH/openspec:*)",
          "Bash($MATE_COMPANION_BIN_PATH/graphify:*)",
        ],
      },
    });

    await syncCompanionClaudeSettings(companionPath, {
      allowedAgents: ["claude"],
      capabilities: [{ name: "openspec" }, { name: "graphify" }],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow).not.toContain("Bash($MATE_COMPANION_BIN_PATH/openspec:*)");
    expect(settings.permissions?.allow).not.toContain("Bash($MATE_COMPANION_BIN_PATH/graphify:*)");
  });

  test("pre-seeds base mate permission allowance", async () => {
    const companionPath = await makeTempDir("mate-companion-base-perm-");
    await syncCompanionClaudeSettings(companionPath, {
      allowedAgents: ["claude"],
      capabilities: [],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow).toContain("Bash(mate:*)");
  });

  test("drops a managed allow entry when its capability is disabled, keeping unmanaged", async () => {
    const companionPath = await makeTempDir("mate-companion-disable-");
    await seedSettings(companionPath, { permissions: { allow: ["Bash(ls:*)"] } });

    await syncCompanionClaudeSettings(
      companionPath,
      {
        allowedAgents: ["claude"],
        git: "auto",
        capabilities: [{ name: "openspec" }],
      },
      openspecContributions(companionPath, true),
    );
    let settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow).toContain("Bash(openspec:*)");
    expect(settings.permissions?.allow).toContain("Bash(ls:*)");

    await syncCompanionClaudeSettings(
      companionPath,
      {
        allowedAgents: ["claude"],
        capabilities: [],
      },
      openspecContributions(companionPath, false),
    );
    settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow ?? []).not.toContain("Bash(openspec:*)");
    expect(settings.permissions?.allow).toContain("Bash(ls:*)");
  });

  test("reconciles react-doctor hook by capability without re-adding mate plugin hooks", async () => {
    const companionPath = await makeTempDir("mate-companion-hook-reconcile-");

    await syncCompanionClaudeSettings(
      companionPath,
      {
        allowedAgents: ["claude"],
        capabilities: [{ name: "react-doctor" }],
      },
      reactDoctorContributions(companionPath, true),
    );
    let settings = await readCompanionSettings(companionPath);
    expect(settings.hooks?.Stop).toBeDefined();
    expect(
      hasPostToolHook(
        settings,
        "PostToolUse",
        `sh "${companionPath}/.claude/hooks/react-doctor.sh"`,
      ),
    ).toBe(true);
    expect(hasValidateHook(settings, companionPath)).toBe(false);

    await syncCompanionClaudeSettings(
      companionPath,
      {
        allowedAgents: ["claude"],
        capabilities: [],
      },
      reactDoctorContributions(companionPath, false),
    );
    settings = await readCompanionSettings(companionPath);
    expect(settings.hooks?.Stop).toBeUndefined();
    expect(
      hasPostToolHook(
        settings,
        "PostToolUse",
        `sh "${companionPath}/.claude/hooks/react-doctor.sh"`,
      ),
    ).toBe(false);
    expect(hasValidateHook(settings, companionPath)).toBe(false);
  });
});

describe("Claude provider apply (mate hook migration)", () => {
  test("creates no mate hook files and strips previously copied ones, keeping capability hooks", async () => {
    const companionPath = await makeTempDir("mate-claude-apply-migrate-");
    const hooksDir = path.join(companionPath, ".claude", "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    for (const stale of [
      "validate-artifact-path",
      "mate-session-banner",
      "mate-artifact-finish.sh",
    ]) {
      await fs.writeFile(path.join(hooksDir, stale), "#!/bin/sh\nexit 0\n", "utf8");
    }
    await fs.writeFile(path.join(hooksDir, "react-doctor.sh"), "#!/bin/sh\nexit 0\n", "utf8");

    await createClaudePlugin().apply({
      companionPath,
      config: { allowedAgents: ["claude"], capabilities: [] },
      mode: "sync",
      activeProviders: ["claude"],
    });

    for (const stale of [
      "validate-artifact-path",
      "mate-session-banner",
      "mate-artifact-finish.sh",
    ]) {
      await expect(fs.access(path.join(hooksDir, stale))).rejects.toThrow();
    }
    // Capability hook files that remain settings-delivered are untouched.
    await expect(fs.access(path.join(hooksDir, "react-doctor.sh"))).resolves.toBeNull();
  });

  test("prunes the emptied hooks directory on a fully migrated companion", async () => {
    const companionPath = await makeTempDir("mate-claude-apply-prune-");
    const hooksDir = path.join(companionPath, ".claude", "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(path.join(hooksDir, "validate-artifact-path"), "#!/bin/sh\n", "utf8");

    await createClaudePlugin().apply({
      companionPath,
      config: { allowedAgents: ["claude"], capabilities: [] },
      mode: "sync",
      activeProviders: ["claude"],
    });

    await expect(fs.access(hooksDir)).rejects.toThrow();
  });
});
