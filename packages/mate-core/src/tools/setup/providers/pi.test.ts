import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createPiPlugin, getCompanionPiMcpConfigPath, getPiExtensionPath } from "./pi";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-pi-provider-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Pi provider", () => {
  test("resolves the bundled extension", async () => {
    await expect(fs.access(getPiExtensionPath())).resolves.toBeNull();
  });

  test("hosts MCP descriptors in companion-owned standard config", async () => {
    const companionPath = await tempDir();
    const plugin = createPiPlugin();
    await plugin.hosting?.mcp?.register(
      {
        companionPath,
        config: {} as never,
        mode: "setup",
        activeProviders: ["pi"],
      },
      { name: "demo", command: "demo-mcp", args: ["serve"] },
    );

    const configPath = getCompanionPiMcpConfigPath(companionPath);
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, any>;
    expect(config.mcpServers.demo).toEqual({ command: "demo-mcp", args: ["serve"] });

    await plugin.hosting?.mcp?.unregister(
      {
        companionPath,
        config: {} as never,
        mode: "sync",
        activeProviders: ["pi"],
      },
      "demo",
    );
    await expect(fs.access(configPath)).rejects.toThrow();
  });
});
