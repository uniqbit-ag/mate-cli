import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { reconcileClaudeContextHooks } from "./claude-context-hooks";

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mate-claude-context-hooks-"));
}

describe("reconcileClaudeContextHooks", () => {
  test("preserves user hooks and installs idempotent SessionStart/UserPromptSubmit hooks", async () => {
    const root = await makeWorkspace();
    const settingsPath = path.join(root, ".claude", "settings.local.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify(
        {
          permissions: { allow: ["Read(src/**)"] },
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo user" }] }],
          },
        },
        null,
        2,
      ),
    );

    expect(await reconcileClaudeContextHooks(root, "/opt/mate cli")).toBe(true);
    const first = await fs.readFile(settingsPath, "utf8");
    const settings = JSON.parse(first) as {
      permissions: { allow: string[] };
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.permissions.allow).toEqual(["Read(src/**)"]);
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[0]?.hooks[0]?.command).toBe("echo user");
    expect(settings.hooks.SessionStart[1]?.hooks[0]?.command).toContain(
      "'/opt/mate cli' workspace resolve-hook --event SessionStart",
    );
    expect(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toContain("UserPromptSubmit");
    expect(await reconcileClaudeContextHooks(root, "/opt/mate cli")).toBe(false);
    expect(await fs.readFile(settingsPath, "utf8")).toBe(first);
  });

  test("creates settings for a workspace without existing Claude configuration", async () => {
    const root = await makeWorkspace();

    expect(await reconcileClaudeContextHooks(root)).toBe(true);

    const settings = JSON.parse(
      await fs.readFile(path.join(root, ".claude", "settings.local.json"), "utf8"),
    ) as { hooks: Record<string, unknown[]> };
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
  });

  test("recognizes the bundled hook runner on repeated activation", async () => {
    const root = await makeWorkspace();
    const runner = { command: "node", args: ["/extension/dist/claude-context-hook.cjs"] };

    expect(await reconcileClaudeContextHooks(root, runner)).toBe(true);
    expect(await reconcileClaudeContextHooks(root, runner)).toBe(false);
  });
});
