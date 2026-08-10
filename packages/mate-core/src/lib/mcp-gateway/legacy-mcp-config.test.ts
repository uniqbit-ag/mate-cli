import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { resolveCompanionMcpServers } from "./legacy-mcp-config";

const tempRoots: string[] = [];

async function makeCompanion(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-mcp-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeOpenCodeConfig(companion: string, mcp: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(companion, ".opencode"), { recursive: true });
  await fs.writeFile(
    path.join(companion, ".opencode", "opencode.json"),
    JSON.stringify({ mcp }),
    "utf8",
  );
}

async function writeClaudeMcp(
  companion: string,
  mcpServers: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(path.join(companion, ".mcp.json"), JSON.stringify({ mcpServers }), "utf8");
}

async function writeCanonical(companion: string, yaml: string): Promise<void> {
  await fs.mkdir(path.join(companion, ".mate"), { recursive: true });
  await fs.writeFile(path.join(companion, ".mate", "mcp.yaml"), yaml, "utf8");
}

describe("resolveCompanionMcpServers", () => {
  test("maps legacy opencode local entries with a deprecation warning", async () => {
    const companion = await makeCompanion();
    await writeOpenCodeConfig(companion, {
      docs: {
        type: "local",
        command: ["node", "docs.mjs"],
        environment: { TOKEN: "t" },
        enabled: true,
      },
    });

    const resolved = await resolveCompanionMcpServers(companion);

    expect(resolved.servers).toEqual([
      {
        name: "docs",
        command: "node",
        args: ["docs.mjs"],
        env: { TOKEN: "t" },
        cwd: companion,
        isolation: "shared",
        enabled: true,
      },
    ]);
    expect(resolved.deprecations).toHaveLength(1);
    expect(resolved.deprecations[0]).toContain(path.join(".opencode", "opencode.json"));
    expect(resolved.deprecations[0]).toContain(path.join(".mate", "mcp.yaml"));
  });

  test("maps legacy .mcp.json stdio entries with a deprecation warning", async () => {
    const companion = await makeCompanion();
    await writeClaudeMcp(companion, {
      api: { type: "stdio", command: "api-mcp", args: ["--flag"], env: { KEY: "v" } },
    });

    const resolved = await resolveCompanionMcpServers(companion);

    expect(resolved.servers).toEqual([
      {
        name: "api",
        command: "api-mcp",
        args: ["--flag"],
        env: { KEY: "v" },
        cwd: companion,
        isolation: "shared",
        enabled: true,
      },
    ]);
    expect(resolved.deprecations).toHaveLength(1);
    expect(resolved.deprecations[0]).toContain(".mcp.json");
  });

  test("canonical config wins name collisions and legacy fills gaps", async () => {
    const companion = await makeCompanion();
    await writeCanonical(
      companion,
      ["servers:", "  docs:", "    command: canonical-docs"].join("\n"),
    );
    await writeOpenCodeConfig(companion, {
      docs: { type: "local", command: ["legacy-docs"] },
      extra: { type: "local", command: ["extra-mcp"] },
    });

    const resolved = await resolveCompanionMcpServers(companion);

    expect(resolved.servers.map((server) => [server.name, server.command])).toEqual([
      ["docs", "canonical-docs"],
      ["extra", "extra-mcp"],
    ]);
  });

  test("opencode entries win .mcp.json collisions (reader order is deterministic)", async () => {
    const companion = await makeCompanion();
    await writeOpenCodeConfig(companion, { dup: { type: "local", command: ["from-opencode"] } });
    await writeClaudeMcp(companion, { dup: { command: "from-claude" } });

    const resolved = await resolveCompanionMcpServers(companion);

    expect(resolved.servers.map((server) => server.command)).toEqual(["from-opencode"]);
    expect(resolved.deprecations).toHaveLength(2);
  });

  test("unsupported legacy entry types become issues, not servers", async () => {
    const companion = await makeCompanion();
    await writeOpenCodeConfig(companion, {
      remote: { type: "remote", url: "https://acme.example" },
    });
    await writeClaudeMcp(companion, {
      http: { type: "http", url: "https://acme.example" },
      broken: { args: ["no-command"] },
    });

    const resolved = await resolveCompanionMcpServers(companion);

    expect(resolved.servers).toEqual([]);
    expect(resolved.issues.map((issue) => issue.server).sort()).toEqual([
      "broken",
      "http",
      "remote",
    ]);
  });

  test("disabled legacy opencode entries stay disabled", async () => {
    const companion = await makeCompanion();
    await writeOpenCodeConfig(companion, {
      off: { type: "local", command: ["off-mcp"], enabled: false },
    });

    const resolved = await resolveCompanionMcpServers(companion);

    expect(resolved.servers[0]!.enabled).toBe(false);
  });

  test("no files means empty result without deprecations", async () => {
    const companion = await makeCompanion();

    expect(await resolveCompanionMcpServers(companion)).toEqual({
      servers: [],
      issues: [],
      deprecations: [],
    });
  });

  test("unparseable legacy JSON is an issue, not a crash", async () => {
    const companion = await makeCompanion();
    await fs.writeFile(path.join(companion, ".mcp.json"), "{nope", "utf8");

    const resolved = await resolveCompanionMcpServers(companion);

    expect(resolved.servers).toEqual([]);
    expect(resolved.issues).toHaveLength(1);
    expect(resolved.issues[0]!.message).toContain("invalid JSON");
  });
});
