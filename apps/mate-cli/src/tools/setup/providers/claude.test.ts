import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import {
  ensureWorkingRepoLocalExcludes,
  getCompanionClaudeMcpConfigPath,
  getCompanionClaudeSettingsPath,
  syncCompanionClaudeSettings,
  syncWorkingRepoClaudeSettings,
} from "./claude";
import { getWrapperBinPath } from "../../../lib/package-paths";

const tempRoots: string[] = [];

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
  test("writes shared PreToolUse hook without react-doctor post hooks by default", async () => {
    const companionPath = await makeTempDir("mate-companion-basic-");
    await syncCompanionClaudeSettings(companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.hooks?.PreToolUse).toEqual([
      {
        matcher: "Write|Edit|MultiEdit|Bash",
        hooks: [
          { type: "command", command: `${companionPath}/.claude/hooks/validate-artifact-path` },
        ],
      },
    ]);
    expect(settings.hooks?.SessionStart).toEqual([
      {
        hooks: [{ type: "command", command: `${companionPath}/.claude/hooks/mate-session-banner` }],
      },
    ]);
    expect(settings.hooks?.Stop).toBeUndefined();
  });

  test("disables auto memory by default", async () => {
    const companionPath = await makeTempDir("mate-companion-auto-memory-");
    await syncCompanionClaudeSettings(companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.autoMemoryEnabled).toBe(false);
  });

  test("adds react-doctor post hook when capability enabled", async () => {
    const companionPath = await makeTempDir("mate-companion-react-doctor-");
    await syncCompanionClaudeSettings(companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [{ name: "react-doctor" }],
    });

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

  test("adds openspec post hook when capability enabled", async () => {
    const companionPath = await makeTempDir("mate-companion-openspec-");
    await syncCompanionClaudeSettings(companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      git: "auto",
      capabilities: [{ name: "openspec" }],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.hooks?.PostToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: `sh "${companionPath}/.claude/hooks/mate-openspec-artifact-finish.sh"`,
          },
        ],
      },
    ]);
    expect(settings.hooks?.Stop).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: `sh "${companionPath}/.claude/hooks/mate-openspec-artifact-finish.sh"`,
            timeout: 10,
          },
        ],
      },
    ]);
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
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.hooks?.PreToolUse).toContainEqual({
      matcher: "Bash",
      hooks: [{ type: "command", command: "echo custom" }],
    });
    expect(hasValidateHook(settings, companionPath)).toBe(true);
    expect(settings.permissions?.allow).toContain("Bash(ls:*)");
  });

  test("resync preserves user-authored SessionStart hooks alongside the managed banner", async () => {
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
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.hooks?.SessionStart).toContainEqual({
      hooks: [{ type: "command", command: `${companionPath}/.claude/hooks/mate-session-banner` }],
    });
    expect(settings.hooks?.SessionStart).toContainEqual({
      hooks: [{ type: "command", command: "echo custom-session-start" }],
    });
    expect(settings.hooks?.SessionStart).toHaveLength(2);
  });

  test("declares tokensave mcp server in .mcp.json and hooks without duplication", async () => {
    const companionPath = await makeTempDir("mate-companion-tokensave-");
    const binDir = await makeTempDir("mate-companion-bin-");
    const originalPath = process.env.PATH;
    const tokensavePath = await makeExecutable(binDir, "tokensave");

    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    await seedSettings(companionPath, {
      permissions: { allow: ["Bash(ls:*)"] },
    });

    try {
      const config = {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        capabilities: [{ name: "tokensave" }],
      };

      await syncCompanionClaudeSettings(companionPath, config);
      await syncCompanionClaudeSettings(companionPath, config);

      const settings = await readCompanionSettings(companionPath);
      // MCP server moved to .mcp.json; settings.local.json must not carry it,
      // but the mcp__tokensave__* permission entry is still pre-seeded.
      expect(settings.permissions?.allow).toContain("Bash(ls:*)");
      expect(settings.permissions?.allow ?? []).toContain("mcp__tokensave__*");
      expect(settings.mcpServers?.tokensave).toBeUndefined();

      const mcpConfig = JSON.parse(
        await fs.readFile(getCompanionClaudeMcpConfigPath(companionPath), "utf8"),
      ) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
      expect(mcpConfig.mcpServers?.tokensave).toEqual({
        command: tokensavePath,
        args: ["serve"],
      });

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
    } finally {
      process.env.PATH = originalPath;
    }
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
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
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
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
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
    ["openspec", "Bash(openspec:*)"],
    ["headroom", "Bash(rtk:*)"],
    ["graphify", "Bash(graphify:*)"],
    ["react-doctor", "Bash(npx react-doctor:*)"],
  ])("pre-seeds %s permission allowance %s", async (name, entry) => {
    const companionPath = await makeTempDir("mate-companion-perm-");
    await syncCompanionClaudeSettings(companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [{ name }],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow).toContain(entry);
  });

  test("pre-seeds package wrapper permission allowances", async () => {
    const companionPath = await makeTempDir("mate-companion-bin-perm-");
    await syncCompanionClaudeSettings(companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [{ name: "openspec" }, { name: "graphify" }],
    });

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
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [{ name: "openspec" }, { name: "graphify" }],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow).not.toContain("Bash($MATE_COMPANION_BIN_PATH/openspec:*)");
    expect(settings.permissions?.allow).not.toContain("Bash($MATE_COMPANION_BIN_PATH/graphify:*)");
  });

  test("pre-seeds base mate permission allowance", async () => {
    const companionPath = await makeTempDir("mate-companion-base-perm-");
    await syncCompanionClaudeSettings(companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [],
    });

    const settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow).toContain("Bash(mate:*)");
  });

  test("drops a managed allow entry when its capability is disabled, keeping unmanaged", async () => {
    const companionPath = await makeTempDir("mate-companion-disable-");
    await seedSettings(companionPath, { permissions: { allow: ["Bash(ls:*)"] } });

    await syncCompanionClaudeSettings(companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      git: "auto",
      capabilities: [{ name: "openspec" }],
    });
    let settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow).toContain("Bash(openspec:*)");
    expect(settings.permissions?.allow).toContain("Bash(ls:*)");

    await syncCompanionClaudeSettings(companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [],
    });
    settings = await readCompanionSettings(companionPath);
    expect(settings.permissions?.allow ?? []).not.toContain("Bash(openspec:*)");
    expect(settings.permissions?.allow).toContain("Bash(ls:*)");
  });

  test("reconciles react-doctor hook by capability while validate hook stays present", async () => {
    const companionPath = await makeTempDir("mate-companion-hook-reconcile-");

    await syncCompanionClaudeSettings(companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [{ name: "react-doctor" }],
    });
    let settings = await readCompanionSettings(companionPath);
    expect(settings.hooks?.Stop).toBeDefined();
    expect(
      hasPostToolHook(
        settings,
        "PostToolUse",
        `sh "${companionPath}/.claude/hooks/react-doctor.sh"`,
      ),
    ).toBe(true);
    expect(hasValidateHook(settings, companionPath)).toBe(true);

    await syncCompanionClaudeSettings(companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [],
    });
    settings = await readCompanionSettings(companionPath);
    expect(settings.hooks?.Stop).toBeUndefined();
    expect(
      hasPostToolHook(
        settings,
        "PostToolUse",
        `sh "${companionPath}/.claude/hooks/react-doctor.sh"`,
      ),
    ).toBe(false);
    expect(hasValidateHook(settings, companionPath)).toBe(true);
  });

  test("reconciles openspec hook by capability while validate hook stays present", async () => {
    const companionPath = await makeTempDir("mate-companion-openspec-reconcile-");

    await syncCompanionClaudeSettings(companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      git: "auto",
      capabilities: [{ name: "openspec" }],
    });
    let settings = await readCompanionSettings(companionPath);
    expect(
      hasPostToolHook(
        settings,
        "PostToolUse",
        `sh "${companionPath}/.claude/hooks/mate-openspec-artifact-finish.sh"`,
      ),
    ).toBe(true);
    expect(hasValidateHook(settings, companionPath)).toBe(true);

    await syncCompanionClaudeSettings(companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [],
    });
    settings = await readCompanionSettings(companionPath);
    expect(
      hasPostToolHook(
        settings,
        "PostToolUse",
        `sh "${companionPath}/.claude/hooks/mate-openspec-artifact-finish.sh"`,
      ),
    ).toBe(false);
    expect(hasValidateHook(settings, companionPath)).toBe(true);
  });
});

describe("syncWorkingRepoClaudeSettings (working-repo cleanup)", () => {
  test("adds .claude/settings.local.json to repo-local git exclude", async () => {
    const workingRepoPath = await makeTempDir("mate-claude-settings-exclude-");
    await fs.mkdir(path.join(workingRepoPath, ".git", "info"), {
      recursive: true,
    });

    await ensureWorkingRepoLocalExcludes(workingRepoPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [],
    });

    const excludePath = path.join(workingRepoPath, ".git", "info", "exclude");
    const exclude = await fs.readFile(excludePath, "utf8");
    expect(exclude).toContain(".claude/settings.local.json\n");

    await ensureWorkingRepoLocalExcludes(workingRepoPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [],
    });
    const secondPassExclude = await fs.readFile(excludePath, "utf8");
    expect(secondPassExclude).toBe(exclude);
  });

  test("tokensave mode adds only the TokenSave store to repo-local git exclude", async () => {
    const workingRepoPath = await makeTempDir("mate-claude-settings-tokensave-exclude-");
    await fs.mkdir(path.join(workingRepoPath, ".git", "info"), {
      recursive: true,
    });

    await ensureWorkingRepoLocalExcludes(workingRepoPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [{ name: "tokensave" }],
    });

    const exclude = await fs.readFile(
      path.join(workingRepoPath, ".git", "info", "exclude"),
      "utf8",
    );
    expect(exclude).toContain(".claude/settings.local.json\n");
    expect(exclude).toContain(".tokensave/\n");
  });

  test("resolves worktree-style .git files when writing repo-local excludes", async () => {
    const workingRepoPath = await makeTempDir("mate-claude-settings-worktree-");
    const gitDir = path.join(workingRepoPath, ".worktrees", "repo-git");
    await fs.mkdir(path.join(gitDir, "info"), { recursive: true });
    await fs.writeFile(path.join(workingRepoPath, ".git"), "gitdir: .worktrees/repo-git\n", "utf8");

    await ensureWorkingRepoLocalExcludes(workingRepoPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [],
    });

    const exclude = await fs.readFile(path.join(gitDir, "info", "exclude"), "utf8");
    expect(exclude).toContain(".claude/settings.local.json\n");
  });

  test("removes obsolete Mate hooks and prunes empty hook containers", async () => {
    const workingRepoPath = await makeTempDir("mate-claude-remove-hooks-");
    const companionPath = await makeTempDir("mate-claude-remove-hooks-companion-");

    await seedSettings(workingRepoPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Write|Edit|MultiEdit|Bash",
            hooks: [
              {
                type: "command",
                command: `${companionPath}/.claude/hooks/validate-artifact-path`,
              },
            ],
          },
        ],
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `${companionPath}/.claude/hooks/mate-session-banner`,
              },
            ],
          },
        ],
        PostToolBatch: [
          {
            hooks: [{ type: "command", command: `${companionPath}/.claude/hooks/react-doctor.sh` }],
          },
        ],
        EmptyEvent: [],
      },
    });

    await syncWorkingRepoClaudeSettings(workingRepoPath, companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [],
    });

    const after = JSON.parse(
      await fs.readFile(path.join(workingRepoPath, ".claude", "settings.local.json"), "utf8"),
    );
    expect(after.hooks).toBeUndefined();
  });

  test("writes companion additionalDirectories to working-repo Claude settings", async () => {
    const workingRepoPath = await makeTempDir("mate-claude-cleanup-none-");
    const companionPath = await makeTempDir("mate-claude-cleanup-companion-");

    await syncWorkingRepoClaudeSettings(workingRepoPath, companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [{ name: "tokensave" }],
    });

    const settings = JSON.parse(
      await fs.readFile(path.join(workingRepoPath, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings).toEqual({
      permissions: {
        additionalDirectories: [path.resolve(companionPath)],
      },
    });
  });

  test("preserves existing working-repo settings while merging additionalDirectories", async () => {
    const workingRepoPath = await makeTempDir("mate-claude-keep-existing-");
    const companionPath = await makeTempDir("mate-claude-keep-companion-");

    // A repo may carry its own working-repo settings file. Mate only manages
    // the companion path entry in permissions.additionalDirectories here.
    const seeded = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Write|Edit|MultiEdit|Bash",
            hooks: [
              {
                type: "command",
                command: `${companionPath}/.claude/hooks/validate-artifact-path`,
              },
            ],
          },
          { matcher: "Bash", hooks: [{ type: "command", command: "echo custom" }] },
        ],
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `${companionPath}/.claude/hooks/mate-session-banner`,
              },
            ],
          },
        ],
        PostToolBatch: [
          {
            hooks: [{ type: "command", command: `${companionPath}/.claude/hooks/react-doctor.sh` }],
          },
        ],
        EmptyEvent: [],
      },
      permissions: {
        additionalDirectories: ["/tmp/shared"],
        allow: ["Bash(ls:*)", "mcp__tokensave__*"],
      },
      mcpServers: {
        other: { command: "echo", args: ["ok"] },
        tokensave: { command: "tokensave", args: ["serve"] },
      },
      env: { MATE_TEST_VALUE: "preserve" },
      customSetting: { keep: true },
    };
    // Legacy Mate permissions and inline MCP entries are intentionally
    // preserved; this migration only removes obsolete hook groups.
    await seedSettings(workingRepoPath, seeded);
    await syncWorkingRepoClaudeSettings(workingRepoPath, companionPath, {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
      capabilities: [{ name: "tokensave" }],
    });

    const after = JSON.parse(
      await fs.readFile(path.join(workingRepoPath, ".claude", "settings.local.json"), "utf8"),
    );
    expect(after).toEqual({
      ...seeded,
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo custom" }] }],
      },
      permissions: {
        additionalDirectories: ["/tmp/shared", path.resolve(companionPath)],
        allow: ["Bash(ls:*)", "mcp__tokensave__*"],
      },
    });
  });

  test("removes stale registered companion directories while keeping the active one", async () => {
    const root = await makeTempDir("mate-claude-remove-stale-");
    const workingRepoPath = path.join(root, "working");
    const activeCompanionPath = path.join(root, "companion-active");
    const staleCompanionPath = path.join(root, "companion-stale");
    const globalConfigStore = new GlobalConfigStore(path.join(root, "global-config.yaml"));

    await fs.mkdir(workingRepoPath, { recursive: true });
    await fs.mkdir(activeCompanionPath, { recursive: true });
    await fs.mkdir(staleCompanionPath, { recursive: true });
    await globalConfigStore.register(activeCompanionPath);
    await globalConfigStore.register(staleCompanionPath);

    await seedSettings(workingRepoPath, {
      permissions: {
        additionalDirectories: [
          "/tmp/shared",
          path.resolve(staleCompanionPath),
          path.resolve(activeCompanionPath),
        ],
      },
    });

    await syncWorkingRepoClaudeSettings(
      workingRepoPath,
      activeCompanionPath,
      {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        capabilities: [{ name: "tokensave" }],
      },
      globalConfigStore,
    );

    const after = JSON.parse(
      await fs.readFile(path.join(workingRepoPath, ".claude", "settings.local.json"), "utf8"),
    );
    expect(after).toEqual({
      permissions: {
        additionalDirectories: ["/tmp/shared", path.resolve(activeCompanionPath)],
      },
    });
  });
});
