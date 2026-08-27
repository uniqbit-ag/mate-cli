import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { ClaudeSettings } from "../../tools/setup/providers/claude-format";
import {
  ensureWorkingRepoLocalExcludes,
  reconcileWorkingRepoCapabilityExcludes,
} from "../../tools/setup/working-repo-local-state";
import { GlobalConfigStore } from "./global-config-store";
import { project } from "./working-repo-projection";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function seedSettings(basePath: string, settings: ClaudeSettings): Promise<void> {
  const settingsPath = path.join(basePath, ".claude", "settings.local.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

describe("the launch scope of the Managed Projection", () => {
  test("adds agent directories to the repo-local managed exclude block", async () => {
    const workingRepoPath = await makeTempDir("mate-claude-settings-exclude-");
    await fs.mkdir(path.join(workingRepoPath, ".git", "info"), {
      recursive: true,
    });

    await ensureWorkingRepoLocalExcludes(workingRepoPath);

    const excludePath = path.join(workingRepoPath, ".git", "info", "exclude");
    const exclude = await fs.readFile(excludePath, "utf8");
    expect(exclude).toContain("/.claude/\n");
    expect(exclude).toContain("/.opencode/\n");
    expect(exclude).toContain("/.agents/\n");

    await ensureWorkingRepoLocalExcludes(workingRepoPath);
    const secondPassExclude = await fs.readFile(excludePath, "utf8");
    expect(secondPassExclude).toBe(exclude);
  });

  test("tokensave mode adds only the TokenSave store to repo-local git exclude", async () => {
    const workingRepoPath = await makeTempDir("mate-claude-settings-tokensave-exclude-");
    await fs.mkdir(path.join(workingRepoPath, ".git", "info"), {
      recursive: true,
    });

    await ensureWorkingRepoLocalExcludes(workingRepoPath);
    await reconcileWorkingRepoCapabilityExcludes(workingRepoPath, [".tokensave/"], [".tokensave/"]);

    const exclude = await fs.readFile(
      path.join(workingRepoPath, ".git", "info", "exclude"),
      "utf8",
    );
    expect(exclude).toContain("/.claude/\n");
    expect(exclude).toContain(".tokensave/\n");
  });

  test("resolves worktree-style .git files when writing repo-local excludes", async () => {
    const workingRepoPath = await makeTempDir("mate-claude-settings-worktree-");
    const gitDir = path.join(workingRepoPath, ".worktrees", "repo-git");
    await fs.mkdir(path.join(gitDir, "info"), { recursive: true });
    await fs.writeFile(path.join(workingRepoPath, ".git"), "gitdir: .worktrees/repo-git\n", "utf8");

    await ensureWorkingRepoLocalExcludes(workingRepoPath);

    const exclude = await fs.readFile(path.join(gitDir, "info", "exclude"), "utf8");
    expect(exclude).toContain("/.claude/\n");
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

    await project("launch", {
      repoPath: workingRepoPath,
      companionPath,
      config: { allowedAgents: ["claude"], capabilities: [] },
    });

    const after = JSON.parse(
      await fs.readFile(path.join(workingRepoPath, ".claude", "settings.local.json"), "utf8"),
    );
    expect(after.hooks).toBeUndefined();
  });

  test("strips the legacy archive-finish guard group and stays idempotent", async () => {
    const workingRepoPath = await makeTempDir("mate-claude-strip-finish-");
    const companionPath = await makeTempDir("mate-claude-strip-finish-companion-");

    await seedSettings(workingRepoPath, {
      hooks: {
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
          { matcher: "Bash", hooks: [{ type: "command", command: "echo user-post-tool" }] },
        ],
      },
    });

    const config = { allowedAgents: ["claude"], capabilities: [] };
    await project("launch", { repoPath: workingRepoPath, companionPath, config });

    const settingsPath = path.join(workingRepoPath, ".claude", "settings.local.json");
    const first = await fs.readFile(settingsPath, "utf8");
    const settings = JSON.parse(first);
    expect(settings.hooks?.PostToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "echo user-post-tool" }] },
    ]);

    await project("launch", { repoPath: workingRepoPath, companionPath, config });
    const second = await fs.readFile(settingsPath, "utf8");
    expect(second).toBe(first);
  });

  test("writes companion additionalDirectories to working-repo Claude settings", async () => {
    const workingRepoPath = await makeTempDir("mate-claude-cleanup-none-");
    const companionPath = await makeTempDir("mate-claude-cleanup-companion-");

    await project("launch", {
      repoPath: workingRepoPath,
      companionPath,
      config: { allowedAgents: ["claude"], capabilities: [{ name: "tokensave" }] },
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
    await project("launch", {
      repoPath: workingRepoPath,
      companionPath,
      config: { allowedAgents: ["claude"], capabilities: [{ name: "tokensave" }] },
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

    await project("launch", {
      repoPath: workingRepoPath,
      companionPath: activeCompanionPath,
      config: { allowedAgents: ["claude"], capabilities: [{ name: "tokensave" }] },
      globalConfigStore,
    });

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
