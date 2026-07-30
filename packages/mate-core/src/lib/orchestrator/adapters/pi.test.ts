import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PiAdapter } from "./pi";
import type { AdapterContext } from "./base";
import { resetActiveDistribution, setActiveDistribution } from "../../../distribution";
import { PluginRegistry } from "../../../tools/setup/registry";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-pi-adapter-"));
  tempRoots.push(dir);
  return dir;
}

function context(companionPath: string): AdapterContext {
  return {
    repository: { id: "repo", path: "/tmp/repo", profile: "default" },
    policy: { allowedAgents: ["pi"] },
    companionPath,
    capabilities: [],
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  resetActiveDistribution();
});

describe("PiAdapter", () => {
  beforeEach(() => {
    setActiveDistribution({
      config: { name: "mate", runtime: "bun", version: "0.0.0" },
      registry: new PluginRegistry([]),
    });
  });

  test("loads the bundled extension and companion MCP config", async () => {
    const companionPath = await tempDir();
    await fs.writeFile(
      path.join(companionPath, ".mcp.json"),
      JSON.stringify({ mcpServers: { demo: { command: "demo-mcp" } } }),
    );
    const launch = new PiAdapter();
    const args = launch.buildArgs(context(companionPath), [
      "--mode",
      "rpc",
      "--session-dir",
      "/tmp/s",
    ]);

    expect(args).toContain("--extension");
    expect(args.find((arg) => arg.endsWith("mate-extension.ts"))).toBeDefined();
    expect(args).toContain("--mcp-config");
    expect(args).toContain(path.join(companionPath, ".mcp.json"));
    expect(args.slice(-4)).toEqual(["--mode", "rpc", "--session-dir", "/tmp/s"]);
  });

  test("preserves Pi interactive, print, JSON, and RPC arguments", async () => {
    const companionPath = await tempDir();
    const adapter = new PiAdapter();
    for (const forwarded of [
      [],
      ["--print", "hello"],
      ["--mode", "json", "hello"],
      ["--mode", "rpc", "--session-id", "session"],
    ]) {
      const args = adapter.buildArgs(context(companionPath), forwarded);
      const tail = forwarded.length === 0 ? [] : args.slice(-forwarded.length);
      expect(tail).toEqual(forwarded);
    }
  });

  test("injects Mate context without changing Pi session settings", async () => {
    const companionPath = await tempDir();
    const env = new PiAdapter().extendEnvironment(context(companionPath));
    expect(env.PI_MATE_ARTIFACT_PATH).toBe(companionPath);
    expect(env.PI_MATE_REPO_PATH).toBe("/tmp/repo");
    expect(env.MATE_PI_GUIDANCE).toContain("companion-policy");
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  test("routes Pi through Headroom with provider endpoints", async () => {
    const companionPath = await tempDir();
    const launch = await new PiAdapter().prepareLaunch(
      { ...context(companionPath), capabilities: [{ name: "headroom" }] },
      [],
      { isProxyReachable: async () => true },
    );

    expect(launch.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8787/p/repo");
    expect(launch.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:8787/p/repo/v1");
  });
});
