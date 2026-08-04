import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  filterClaudeHookGroups,
  mergeClaudeHookGroups,
  readClaudeMcpConfig,
  readClaudeSettings,
  toClaudeMcpEntry,
  updateClaudeMcpServer,
  writeClaudeSettings,
} from "./claude-format";

const tempRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-format-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("mergeClaudeHookGroups", () => {
  test("appends incoming groups per event and dedupes identical groups", () => {
    const existing = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "a.sh" }] }],
    };
    const incoming = {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "a.sh" }] },
        { matcher: "Edit", hooks: [{ type: "command", command: "b.sh" }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "c.sh" }] }],
    };

    const merged = mergeClaudeHookGroups(existing, incoming);

    expect(merged.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "a.sh" }] },
      { matcher: "Edit", hooks: [{ type: "command", command: "b.sh" }] },
    ]);
    expect(merged.Stop).toEqual([{ hooks: [{ type: "command", command: "c.sh" }] }]);
    expect(existing.PreToolUse).toHaveLength(1);
  });
});

describe("filterClaudeHookGroups", () => {
  test("keeps matching groups and drops events left empty", () => {
    const hooks = {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "managed.sh" }] },
        { matcher: "Edit", hooks: [{ type: "command", command: "user.sh" }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "managed.sh" }] }],
    };

    const filtered = filterClaudeHookGroups(hooks, (group) =>
      (group.hooks ?? []).every((hook) => hook.command !== "managed.sh"),
    );

    expect(filtered).toEqual({
      PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "user.sh" }] }],
    });
  });
});

describe("readClaudeSettings / writeClaudeSettings", () => {
  test("absent or malformed files read as empty settings", async () => {
    const dir = await makeTempDir();
    expect(await readClaudeSettings(path.join(dir, "missing.json"))).toEqual({});

    const malformedPath = path.join(dir, "broken.json");
    await fs.writeFile(malformedPath, "not json", "utf8");
    expect(await readClaudeSettings(malformedPath)).toEqual({});
  });

  test("writes pretty JSON with trailing newline, creating parent dirs", async () => {
    const dir = await makeTempDir();
    const settingsPath = path.join(dir, ".claude", "settings.local.json");

    await writeClaudeSettings(settingsPath, { permissions: { allow: ["Bash(x:*)"] } });

    const raw = await fs.readFile(settingsPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual({ permissions: { allow: ["Bash(x:*)"] } });
  });
});

describe("toClaudeMcpEntry", () => {
  test("url descriptor becomes a url entry", () => {
    expect(toClaudeMcpEntry({ name: "s", url: "https://example.test" })).toEqual({
      url: "https://example.test",
    });
  });

  test("command descriptor keeps args and env only when present", () => {
    expect(toClaudeMcpEntry({ name: "s", command: "tokensave", args: ["serve"] })).toEqual({
      command: "tokensave",
      args: ["serve"],
    });
    expect(toClaudeMcpEntry({ name: "s", command: "tokensave" })).toEqual({
      command: "tokensave",
    });
  });
});

describe("updateClaudeMcpServer", () => {
  test("adding a server creates the config file", async () => {
    const dir = await makeTempDir();
    const mcpConfigPath = path.join(dir, ".mcp.json");

    await updateClaudeMcpServer(mcpConfigPath, "tokensave", {
      command: "tokensave",
      args: ["serve"],
    });

    expect(JSON.parse(await fs.readFile(mcpConfigPath, "utf8"))).toEqual({
      mcpServers: { tokensave: { command: "tokensave", args: ["serve"] } },
    });
  });

  test("removing a server preserves unrelated entries and keys", async () => {
    const dir = await makeTempDir();
    const mcpConfigPath = path.join(dir, ".mcp.json");
    await fs.writeFile(
      mcpConfigPath,
      JSON.stringify({ custom: true, mcpServers: { tokensave: {}, other: { command: "x" } } }),
      "utf8",
    );

    await updateClaudeMcpServer(mcpConfigPath, "tokensave", null);

    expect(JSON.parse(await fs.readFile(mcpConfigPath, "utf8"))).toEqual({
      custom: true,
      mcpServers: { other: { command: "x" } },
    });
  });

  test("removing from an absent file does not create it", async () => {
    const dir = await makeTempDir();
    const mcpConfigPath = path.join(dir, ".mcp.json");

    await updateClaudeMcpServer(mcpConfigPath, "tokensave", null);

    await expect(fs.access(mcpConfigPath)).rejects.toThrow();
  });
});

describe("readClaudeMcpConfig", () => {
  test("reports presence and parses the config", async () => {
    const dir = await makeTempDir();
    const mcpConfigPath = path.join(dir, ".mcp.json");

    expect(await readClaudeMcpConfig(mcpConfigPath)).toEqual({ present: false, config: {} });

    await fs.writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { a: {} } }), "utf8");
    expect(await readClaudeMcpConfig(mcpConfigPath)).toEqual({
      present: true,
      config: { mcpServers: { a: {} } },
    });
  });
});
