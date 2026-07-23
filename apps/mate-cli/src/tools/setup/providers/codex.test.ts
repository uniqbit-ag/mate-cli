import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, test } from "bun:test";

import type { FrameworkConfig } from "../../../lib/orchestrator/types";
import { codexPlugin, syncWorkingRepoCodexState } from "./codex";

const roots: string[] = [];
const enabled: FrameworkConfig = {
  profiles: { default: { name: "default", allowedAgents: ["codex"] } },
};
const disabled: FrameworkConfig = {
  profiles: { default: { name: "default", allowedAgents: [] } },
};

async function temp(prefix: string): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

async function seedCompanion(companion: string): Promise<void> {
  await fs.mkdir(path.join(companion, ".codex", "skills", "mate-skill"), { recursive: true });
  await fs.writeFile(
    path.join(companion, ".codex", "skills", "mate-skill", "SKILL.md"),
    "# skill\n",
  );
  await fs.writeFile(
    path.join(companion, ".codex", "hooks.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "mate-managed" }] }] } }),
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("syncWorkingRepoCodexState", () => {
  test("generates companion guidance and base hooks", async () => {
    const companion = await temp("mate-codex-generated-");
    await codexPlugin.apply({
      companionPath: companion,
      config: enabled,
      mode: "setup",
      activeProviders: ["codex"],
    });

    expect(await fs.readFile(path.join(companion, "AGENTS.md"), "utf8")).toContain(
      "MATE:COMPANION:START",
    );
    const hooks = JSON.parse(
      await fs.readFile(path.join(companion, ".codex", "hooks.json"), "utf8"),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.PreToolUse).toHaveLength(1);
    const commands = Object.values(hooks.hooks)
      .flat()
      .flatMap((group) => group.hooks)
      .map((hook) => hook.command);
    expect(commands.every((command: string) => command.startsWith('node "'))).toBe(true);
    expect(commands.join(" ")).not.toMatch(/python3|\bsh\b|MATE_HOOK_PROVIDER=/);
  });

  test("links skills, merges hooks, and is idempotent", async () => {
    const working = await temp("mate-codex-working-");
    const companion = await temp("mate-codex-companion-");
    await fs.mkdir(path.join(working, ".git", "info"), { recursive: true });
    await seedCompanion(companion);

    await syncWorkingRepoCodexState(working, companion, enabled);
    const first = await fs.readFile(path.join(working, ".codex", "hooks.json"), "utf8");
    await syncWorkingRepoCodexState(working, companion, enabled);
    expect(await fs.readFile(path.join(working, ".codex", "hooks.json"), "utf8")).toBe(first);
    expect(
      (await fs.lstat(path.join(working, ".agents", "skills", "mate-skill"))).isSymbolicLink(),
    ).toBe(true);
  });

  test("preserves user hooks and removes only managed state when disabled", async () => {
    const working = await temp("mate-codex-cleanup-");
    const companion = await temp("mate-codex-cleanup-companion-");
    await fs.mkdir(path.join(working, ".git", "info"), { recursive: true });
    await fs.mkdir(path.join(working, ".codex"), { recursive: true });
    await fs.writeFile(
      path.join(working, ".codex", "hooks.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "user-hook" }] }] } }),
    );
    await seedCompanion(companion);

    await syncWorkingRepoCodexState(working, companion, enabled);
    await syncWorkingRepoCodexState(working, companion, disabled);
    const hooks = JSON.parse(await fs.readFile(path.join(working, ".codex", "hooks.json"), "utf8"));
    expect(hooks.hooks.Stop[0].hooks[0].command).toBe("user-hook");
    expect(hooks.hooks.SessionStart).toBeUndefined();
    await expect(
      fs.access(path.join(working, ".agents", "skills", "mate-skill")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(working, ".mate", "config", "codex-runtime.json")),
    ).rejects.toThrow();
  });

  test("rejects user-owned skill collisions", async () => {
    const working = await temp("mate-codex-collision-");
    const companion = await temp("mate-codex-collision-companion-");
    await seedCompanion(companion);
    await fs.mkdir(path.join(working, ".agents", "skills", "mate-skill"), { recursive: true });
    await expect(syncWorkingRepoCodexState(working, companion, enabled)).rejects.toThrow(
      /Codex skill collision/,
    );
  });

  test("refuses to overwrite malformed working-repo hooks", async () => {
    const working = await temp("mate-codex-malformed-");
    const companion = await temp("mate-codex-malformed-companion-");
    await seedCompanion(companion);
    await fs.mkdir(path.join(working, ".codex"), { recursive: true });
    const hooksPath = path.join(working, ".codex", "hooks.json");
    await fs.writeFile(hooksPath, "{ malformed\n");

    await expect(syncWorkingRepoCodexState(working, companion, enabled)).rejects.toThrow(
      new RegExp(hooksPath.replaceAll("\\", "\\\\")),
    );
    expect(await fs.readFile(hooksPath, "utf8")).toBe("{ malformed\n");
  });

  test("does not duplicate an equivalent existing hook", async () => {
    const working = await temp("mate-codex-equivalent-");
    const companion = await temp("mate-codex-equivalent-companion-");
    await seedCompanion(companion);
    await fs.mkdir(path.join(working, ".codex"), { recursive: true });
    await fs.copyFile(
      path.join(companion, ".codex", "hooks.json"),
      path.join(working, ".codex", "hooks.json"),
    );

    await syncWorkingRepoCodexState(working, companion, enabled);
    const hooks = JSON.parse(await fs.readFile(path.join(working, ".codex", "hooks.json"), "utf8"));
    expect(hooks.hooks.SessionStart).toHaveLength(1);
  });

  test("fails a conflicting hook using a Mate-managed command", async () => {
    const working = await temp("mate-codex-hook-collision-");
    const companion = await temp("mate-codex-hook-collision-companion-");
    await seedCompanion(companion);
    await fs.mkdir(path.join(working, ".codex"), { recursive: true });
    await fs.writeFile(
      path.join(working, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ matcher: "different", hooks: [{ command: "mate-managed" }] }] },
      }),
    );

    await expect(syncWorkingRepoCodexState(working, companion, enabled)).rejects.toThrow(
      /hooks\.SessionStart/,
    );
  });

  test("fails when a managed hook command is extended with custom arguments", async () => {
    const working = await temp("mate-codex-command-modified-");
    const companion = await temp("mate-codex-command-modified-companion-");
    await seedCompanion(companion);
    await syncWorkingRepoCodexState(working, companion, enabled);
    const hooksPath = path.join(working, ".codex", "hooks.json");
    const hooks = JSON.parse(await fs.readFile(hooksPath, "utf8"));
    hooks.hooks.SessionStart[0].hooks[0].command += " --custom";
    await fs.writeFile(hooksPath, JSON.stringify(hooks, null, 2));

    await expect(syncWorkingRepoCodexState(working, companion, enabled)).rejects.toThrow(
      /Mate-managed hook was modified/,
    );
  });

  test("preserves a user-modified formerly managed group during teardown", async () => {
    const working = await temp("mate-codex-owned-modified-");
    const companion = await temp("mate-codex-owned-modified-companion-");
    await seedCompanion(companion);
    await syncWorkingRepoCodexState(working, companion, enabled);
    const hooksPath = path.join(working, ".codex", "hooks.json");
    const hooks = JSON.parse(await fs.readFile(hooksPath, "utf8"));
    hooks.hooks.SessionStart[0].hooks.push({ command: "user-added" });
    await fs.writeFile(hooksPath, JSON.stringify(hooks, null, 2));

    await expect(syncWorkingRepoCodexState(working, companion, enabled)).rejects.toThrow(
      /hooks\.SessionStart/,
    );
    const afterRejectedSync = JSON.parse(await fs.readFile(hooksPath, "utf8"));
    expect(afterRejectedSync.hooks.SessionStart[0].hooks).toContainEqual({
      command: "user-added",
    });

    await syncWorkingRepoCodexState(working, companion, disabled);
    const after = JSON.parse(await fs.readFile(hooksPath, "utf8"));
    expect(after.hooks.SessionStart[0].hooks).toContainEqual({ command: "user-added" });
    expect(after.hooks.SessionStart[0].hooks).toContainEqual({ command: "mate-managed" });
  });

  test("Codex artifact guard permits new Markdown in a documentation application", async () => {
    const repo = await temp("mate-codex-docs-");
    const companion = await temp("mate-codex-docs-companion-");
    await codexPlugin.apply({
      companionPath: companion,
      config: enabled,
      mode: "setup",
      activeProviders: ["codex"],
    });
    spawnSync("git", ["init", "-q"], { cwd: repo });
    await fs.mkdir(path.join(repo, "apps", "docs"), { recursive: true });
    await fs.writeFile(path.join(repo, "apps", "docs", "package.json"), "{}\n");
    const result = spawnSync(
      "node",
      [path.join(companion, ".codex", "hooks", "validate-artifact-path.cjs")],
      {
        input: JSON.stringify({
          tool_name: "Write",
          tool_input: { file_path: "apps/docs/content/new.md" },
        }),
        env: { ...process.env, MATE_REPO_PATH: repo, MATE_ARTIFACT_PATH: companion },
      },
    );
    expect(result.status).toBe(0);

    const external = path.join(await temp("mate-codex-external-"), "storybook", "spec.md");
    const blocked = spawnSync(
      "node",
      [path.join(companion, ".codex", "hooks", "validate-artifact-path.cjs")],
      {
        input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: external } }),
        env: { ...process.env, MATE_REPO_PATH: repo, MATE_ARTIFACT_PATH: companion },
      },
    );
    expect(blocked.status).toBe(2);
  });
});
