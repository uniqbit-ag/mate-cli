import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { CapabilityContributionInput, SetupContext } from "../plugin";
import {
  mergeClaudeSettingsJsonHooks,
  patchClaudeSkillTree,
  reconcileClaudeContributions,
  removeClaudeHookGroupsWhere,
  stripClaudeForeignSections,
} from "./claude";

const tempRoots: string[] = [];

async function makeCompanion(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-reconcile-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeCtx(companionPath: string): SetupContext {
  return {
    companionPath,
    config: { allowedAgents: ["claude"], capabilities: [] },
    mode: "setup",
    activeProviders: ["claude"],
  };
}

function contribution(
  pluginId: string,
  enabled: boolean,
  companionPath: string,
): CapabilityContributionInput {
  return {
    pluginId,
    enabled,
    contributions: {
      mcpServers: [{ name: "acme", command: "acme", args: ["serve"] }],
      hookGroups: [
        {
          event: "PreToolUse",
          marker: "acme-hook.sh",
          group: {
            matcher: "Bash",
            hooks: [{ type: "command", command: `sh "${companionPath}/acme-hook.sh"` }],
          },
        },
      ],
      permissionEntries: ["mcp__acme__*"],
      guidanceSections: [{ content: "## Acme\n\nUse the acme tools." }],
      skillTrees: [{ name: "acme", sourceDir: path.join(companionPath, "skill-src") }],
    },
  };
}

async function seedSkillSource(companionPath: string): Promise<void> {
  const src = path.join(companionPath, "skill-src");
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, "SKILL.md"), "acme skill\n", "utf8");
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

describe("reconcileClaudeContributions", () => {
  test("enabled contributions land in settings, mcp config, guidance, and skills", async () => {
    const companionPath = await makeCompanion();
    await seedSkillSource(companionPath);
    const ctx = makeCtx(companionPath);

    await reconcileClaudeContributions(ctx, [contribution("acme", true, companionPath)]);

    const settings = (await readJson(
      path.join(companionPath, ".claude", "settings.local.json"),
    )) as {
      hooks: Record<string, unknown[]>;
      permissions: { allow: string[] };
    };
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: `sh "${companionPath}/acme-hook.sh"` }],
      },
    ]);
    expect(settings.permissions.allow).toContain("mcp__acme__*");

    const mcp = (await readJson(path.join(companionPath, ".mcp.json"))) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers.acme).toEqual({ command: "acme", args: ["serve"] });

    const claudeMd = await fs.readFile(path.join(companionPath, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("## Acme");

    await fs.access(path.join(companionPath, ".claude", "skills", "acme", "SKILL.md"));
  });

  test("reconciliation is idempotent", async () => {
    const companionPath = await makeCompanion();
    await seedSkillSource(companionPath);
    const ctx = makeCtx(companionPath);
    const inputs = [contribution("acme", true, companionPath)];

    await reconcileClaudeContributions(ctx, inputs);
    const settingsPath = path.join(companionPath, ".claude", "settings.local.json");
    const first = await fs.readFile(settingsPath, "utf8");
    const firstClaudeMd = await fs.readFile(path.join(companionPath, "CLAUDE.md"), "utf8");

    await reconcileClaudeContributions(ctx, inputs);

    expect(await fs.readFile(settingsPath, "utf8")).toBe(first);
    expect(await fs.readFile(path.join(companionPath, "CLAUDE.md"), "utf8")).toBe(firstClaudeMd);
  });

  test("disabling removes managed entries but preserves user content", async () => {
    const companionPath = await makeCompanion();
    await seedSkillSource(companionPath);
    const ctx = makeCtx(companionPath);

    await reconcileClaudeContributions(ctx, [contribution("acme", true, companionPath)]);

    // User-authored content added between passes must survive teardown.
    const settingsPath = path.join(companionPath, ".claude", "settings.local.json");
    const settings = (await readJson(settingsPath)) as Record<string, unknown> & {
      hooks: Record<string, unknown[]>;
      permissions: { allow: string[] };
    };
    settings.hooks.PreToolUse = [
      ...settings.hooks.PreToolUse,
      { matcher: "Edit", hooks: [{ type: "command", command: "user-hook.sh" }] },
    ];
    settings.permissions.allow.push("User(entry)");
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    await fs.appendFile(path.join(companionPath, "CLAUDE.md"), "\n# User notes\n", "utf8");

    await reconcileClaudeContributions(ctx, [contribution("acme", false, companionPath)]);

    const after = (await readJson(settingsPath)) as {
      hooks?: Record<string, unknown[]>;
      permissions?: { allow?: string[] };
    };
    expect(after.hooks?.PreToolUse).toEqual([
      { matcher: "Edit", hooks: [{ type: "command", command: "user-hook.sh" }] },
    ]);
    expect(after.permissions?.allow).toContain("User(entry)");
    expect(after.permissions?.allow).not.toContain("mcp__acme__*");

    const mcp = (await readJson(path.join(companionPath, ".mcp.json"))) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(mcp.mcpServers?.acme).toBeUndefined();

    const claudeMd = await fs.readFile(path.join(companionPath, "CLAUDE.md"), "utf8");
    expect(claudeMd).not.toContain("## Acme");
    expect(claudeMd).toContain("# User notes");

    await expect(
      fs.access(path.join(companionPath, ".claude", "skills", "acme")),
    ).rejects.toThrow();
  });
});

describe("claude escape hatch", () => {
  test("patchClaudeSkillTree rewrites SKILL.md and references except excluded files", async () => {
    const companionPath = await makeCompanion();
    const skillDir = path.join(companionPath, ".claude", "skills", "acme");
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "write to out/\n", "utf8");
    await fs.writeFile(path.join(skillDir, "references", "usage.md"), "out/ paths\n", "utf8");
    await fs.writeFile(path.join(skillDir, "references", "keep.md"), "out/ stays\n", "utf8");

    await patchClaudeSkillTree(
      companionPath,
      "acme",
      (content) => content.replaceAll("out/", "$OUT"),
      { excludeFiles: ["keep.md"] },
    );

    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe("write to $OUT\n");
    expect(await fs.readFile(path.join(skillDir, "references", "usage.md"), "utf8")).toBe(
      "$OUT paths\n",
    );
    expect(await fs.readFile(path.join(skillDir, "references", "keep.md"), "utf8")).toBe(
      "out/ stays\n",
    );
  });

  test("stripClaudeForeignSections strips companion and repo CLAUDE.md sections", async () => {
    const companionPath = await makeCompanion();
    const repoPath = path.join(companionPath, "repo");
    await fs.mkdir(repoPath, { recursive: true });
    const section = "# Keep\n\n## acme\n\nForeign body.\n";
    await fs.writeFile(path.join(companionPath, "CLAUDE.md"), section, "utf8");
    await fs.writeFile(path.join(repoPath, "CLAUDE.md"), section, "utf8");

    await stripClaudeForeignSections(companionPath, {
      isHeading: (line) => /^##\s+acme\s*$/.test(line),
      repoPath,
    });

    expect(await fs.readFile(path.join(companionPath, "CLAUDE.md"), "utf8")).toBe("# Keep\n");
    expect(await fs.readFile(path.join(repoPath, "CLAUDE.md"), "utf8")).toBe("# Keep\n");
  });

  test("mergeClaudeSettingsJsonHooks absorbs settings.json hooks and removes the file", async () => {
    const companionPath = await makeCompanion();
    const claudeDir = path.join(companionPath, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, "settings.local.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "existing.sh" }] }] } }),
      "utf8",
    );
    await fs.writeFile(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "foreign.sh" }] }] } }),
      "utf8",
    );

    await mergeClaudeSettingsJsonHooks(companionPath);

    const settings = (await readJson(path.join(claudeDir, "settings.local.json"))) as {
      hooks: { Stop: unknown[] };
    };
    expect(settings.hooks.Stop).toEqual([
      { hooks: [{ command: "existing.sh" }] },
      { hooks: [{ command: "foreign.sh" }] },
    ]);
    await expect(fs.access(path.join(claudeDir, "settings.json"))).rejects.toThrow();
  });

  test("removeClaudeHookGroupsWhere removes matching groups and prunes empty containers", async () => {
    const companionPath = await makeCompanion();
    const claudeDir = path.join(companionPath, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ command: "foreign.sh" }] }],
          PreToolUse: [{ hooks: [{ command: "foreign.sh" }] }, { hooks: [{ command: "user.sh" }] }],
        },
      }),
      "utf8",
    );

    await removeClaudeHookGroupsWhere(companionPath, (group) =>
      (group.hooks ?? []).some((hook) => hook.command === "foreign.sh"),
    );

    const settings = (await readJson(path.join(claudeDir, "settings.local.json"))) as {
      hooks: Record<string, unknown[]>;
    };
    expect(settings.hooks.Stop).toBeUndefined();
    expect(settings.hooks.PreToolUse).toEqual([{ hooks: [{ command: "user.sh" }] }]);
  });
});
