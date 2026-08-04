import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  getOpenCodePluginReferences,
  mergeOpenCodeConfigContent,
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

    await writeOpenCodeConfig(configPath, { mcp: { tokensave: { enabled: true } } });

    const raw = await fs.readFile(configPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual({ mcp: { tokensave: { enabled: true } } });
  });
});

describe("plugin references", () => {
  test("reads plugin entries and tolerates a missing array", () => {
    expect(getOpenCodePluginReferences({})).toEqual([]);
    expect(getOpenCodePluginReferences({ plugin: ["a", "b"] })).toEqual(["a", "b"]);
  });

  test("setting references replaces the array and drops it when empty", () => {
    const config: Record<string, unknown> = { plugin: ["a"], other: true };

    setOpenCodePluginReferences(config, ["a", "b"]);
    expect(config.plugin).toEqual(["a", "b"]);

    setOpenCodePluginReferences(config, []);
    expect("plugin" in config).toBe(false);
    expect(config.other).toBe(true);
  });
});

describe("toOpenCodeMcpEntry", () => {
  test("url descriptor becomes a remote entry", () => {
    expect(toOpenCodeMcpEntry({ name: "s", url: "https://example.test" })).toEqual({
      type: "remote",
      url: "https://example.test",
      enabled: true,
    });
  });

  test("command descriptor becomes a local entry with flattened command", () => {
    expect(
      toOpenCodeMcpEntry({ name: "s", command: "tokensave", args: ["serve"], env: { A: "1" } }),
    ).toEqual({
      type: "local",
      command: ["tokensave", "serve"],
      environment: { A: "1" },
      enabled: true,
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
    ).toEqual({ skills: { paths: ["/skills"] } });

    const envWithSkills = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: ["/skills"] } }),
    } as NodeJS.ProcessEnv;
    expect(
      JSON.parse(
        mergeOpenCodeConfigContent({}, envWithSkills, { appendSkillPaths: ["/skills", "/new"] }),
      ),
    ).toEqual({ skills: { paths: ["/skills", "/new"] } });
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
      mcp: { tokensave: { type: "local", command: ["tokensave", "serve"], enabled: true } },
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

    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({ plugin: ["x"] });
  });

  test("removing from an absent file does not create it", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, ".opencode", "opencode.json");

    await updateOpenCodeMcpServer(configPath, "tokensave", null);

    await expect(fs.access(configPath)).rejects.toThrow();
  });
});
