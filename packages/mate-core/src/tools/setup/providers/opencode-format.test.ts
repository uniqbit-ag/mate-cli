import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  getOpenCodePluginReferences,
  mergeOpenCodeConfigContent,
  normalizeOpenCodeConfig,
  readOpenCodeConfig,
  setOpenCodePluginReferences,
  toOpenCodeMcpEntry,
  updateOpenCodeMcpServer,
  writeOpenCodeConfig,
} from "./opencode-format";

const tempRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-format-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("readOpenCodeConfig / writeOpenCodeConfig", () => {
  test("absent or malformed configs read as empty and not present", async () => {
    const dir = await makeTempDir();
    expect(await readOpenCodeConfig(path.join(dir, "missing.json"))).toEqual({
      present: false,
      config: {},
    });

    const malformedPath = path.join(dir, "broken.json");
    await fs.writeFile(malformedPath, "[1, 2]", "utf8");
    expect(await readOpenCodeConfig(malformedPath)).toEqual({ present: false, config: {} });
  });

  test("writes pretty JSON with trailing newline, creating parent dirs", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, ".opencode", "opencode.json");

    await writeOpenCodeConfig(configPath, {
      mcp: { servers: { tokensave: { disabled: false } } },
    });

    const raw = await fs.readFile(configPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual({
      mcp: { servers: { tokensave: { disabled: false } } },
    });
  });
});

describe("plugin references", () => {
  test("reads plugin entries and tolerates a missing array", () => {
    expect(getOpenCodePluginReferences({})).toEqual([]);
    expect(getOpenCodePluginReferences({ plugin: ["a"], plugins: ["b"] })).toEqual(["a", "b"]);
  });

  test("setting references replaces the array and drops it when empty", () => {
    const config: Record<string, unknown> = { plugin: ["a"], other: true };

    setOpenCodePluginReferences(config, ["a", "b"]);
    expect(config.plugins).toEqual(["a", "b"]);
    expect(config.plugin).toBeUndefined();

    setOpenCodePluginReferences(config, []);
    expect("plugins" in config).toBe(false);
    expect(config.other).toBe(true);
  });
});

describe("V1 config normalization", () => {
  test("migrates Mate-relevant V1 config fields and preserves existing V2 settings", () => {
    const config = normalizeOpenCodeConfig({
      plugin: ["mate@1", ["./local", { enabled: true }]],
      plugins: ["user-plugin"],
      compaction: { preserve_recent_tokens: 8000, reserved: 20000, prune: true },
      mcp: {
        playwright: {
          type: "local",
          command: ["npx", "@playwright/mcp"],
          enabled: true,
          timeout: 30000,
        },
      },
      permission: {
        bash: { "git push *": "ask" },
        external_directory: { "/tmp/companion/**": "allow" },
      },
      tools: { websearch: false },
      skills: { paths: ["./team-skills"], urls: ["https://example.test/skills/"] },
      instructions: ["./custom.md"],
    });

    expect(config).toEqual({
      plugins: ["mate@1", { package: "./local", options: { enabled: true } }, "user-plugin"],
      compaction: { keep: { tokens: 8000 }, buffer: 20000 },
      mcp: {
        servers: {
          playwright: {
            type: "local",
            command: ["npx", "@playwright/mcp"],
            disabled: false,
            timeout: { catalog: 30000, execution: 30000 },
          },
        },
      },
      permissions: [
        { action: "shell", resource: "git push *", effect: "ask" },
        { action: "external_directory", resource: "/tmp/companion/**", effect: "allow" },
        { action: "websearch", resource: "*", effect: "deny" },
      ],
      skills: ["./team-skills", "https://example.test/skills/"],
      instructions: ["./custom.md"],
    });
  });
});

describe("toOpenCodeMcpEntry", () => {
  test("url descriptor becomes a remote entry", () => {
    expect(toOpenCodeMcpEntry({ name: "s", url: "https://example.test" })).toEqual({
      type: "remote",
      url: "https://example.test",
      disabled: false,
    });
  });

  test("command descriptor becomes a local entry with flattened command", () => {
    expect(
      toOpenCodeMcpEntry({ name: "s", command: "tokensave", args: ["serve"], env: { A: "1" } }),
    ).toEqual({
      type: "local",
      command: ["tokensave", "serve"],
      environment: { A: "1" },
      disabled: false,
    });
  });
});

describe("mergeOpenCodeConfigContent", () => {
  test("deep-merges the overlay into inherited OPENCODE_CONFIG_CONTENT", () => {
    const env = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { anthropic: { options: { model: "keep" } } },
      }),
    } as NodeJS.ProcessEnv;

    const merged = JSON.parse(
      mergeOpenCodeConfigContent({ provider: { anthropic: { options: { baseURL: "x" } } } }, env),
    );

    expect(merged).toEqual({
      provider: { anthropic: { options: { model: "keep", baseURL: "x" } } },
    });
  });

  test("ignores invalid inherited content and skips already-present skill paths", () => {
    const env = { OPENCODE_CONFIG_CONTENT: "not json" } as NodeJS.ProcessEnv;
    expect(
      JSON.parse(mergeOpenCodeConfigContent({}, env, { appendSkillPaths: ["/skills"] })),
    ).toEqual({ skills: ["/skills"] });

    const envWithSkills = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: ["/skills"] }),
    } as NodeJS.ProcessEnv;
    expect(
      JSON.parse(
        mergeOpenCodeConfigContent({}, envWithSkills, { appendSkillPaths: ["/skills", "/new"] }),
      ),
    ).toEqual({ skills: ["/skills", "/new"] });
  });
});

describe("updateOpenCodeMcpServer", () => {
  test("adding a server creates the config file", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, ".opencode", "opencode.json");

    await updateOpenCodeMcpServer(configPath, "tokensave", {
      type: "local",
      command: ["tokensave", "serve"],
      enabled: true,
    });

    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      mcp: {
        servers: {
          tokensave: {
            type: "local",
            command: ["tokensave", "serve"],
            disabled: false,
          },
        },
      },
    });
  });

  test("removing the last server drops the mcp key but keeps other keys", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, ".opencode", "opencode.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ plugin: ["x"], mcp: { tokensave: { enabled: true } } }),
      "utf8",
    );

    await updateOpenCodeMcpServer(configPath, "tokensave", null);

    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({ plugins: ["x"] });
  });

  test("removing from an absent file does not create it", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, ".opencode", "opencode.json");

    await updateOpenCodeMcpServer(configPath, "tokensave", null);

    await expect(fs.access(configPath)).rejects.toThrow();
  });
});
