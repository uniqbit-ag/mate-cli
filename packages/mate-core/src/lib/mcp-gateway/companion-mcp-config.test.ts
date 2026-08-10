import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  companionMcpConfigPath,
  loadCompanionMcpConfig,
  parseCompanionMcpConfig,
} from "./companion-mcp-config";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const COMPANION = "/companions/acme";

describe("parseCompanionMcpConfig", () => {
  test("parses a full server definition", () => {
    const config = parseCompanionMcpConfig(
      [
        "servers:",
        "  browser:",
        "    command: npx",
        '    args: ["-y", "@acme/browser-mcp"]',
        "    env:",
        "      ACME_TOKEN: secret",
        "    cwd: tools",
        "    isolation: connection",
        "    enabled: false",
      ].join("\n"),
      COMPANION,
    );

    expect(config.issues).toEqual([]);
    expect(config.servers).toEqual([
      {
        name: "browser",
        command: "npx",
        args: ["-y", "@acme/browser-mcp"],
        env: { ACME_TOKEN: "secret" },
        cwd: path.join(COMPANION, "tools"),
        isolation: "connection",
        enabled: false,
      },
    ]);
  });

  test("applies defaults: empty args/env, companion cwd, shared isolation, enabled", () => {
    const config = parseCompanionMcpConfig(
      ["servers:", "  docs:", "    command: docs-mcp"].join("\n"),
      COMPANION,
    );

    expect(config.servers).toEqual([
      {
        name: "docs",
        command: "docs-mcp",
        args: [],
        env: {},
        cwd: COMPANION,
        isolation: "shared",
        enabled: true,
      },
    ]);
  });

  test("keeps auth material in env and args verbatim", () => {
    const config = parseCompanionMcpConfig(
      [
        "servers:",
        "  api:",
        "    command: api-mcp",
        '    args: ["--token", "tok_123"]',
        "    env:",
        "      OAUTH_CLIENT_SECRET: cs_456",
      ].join("\n"),
      COMPANION,
    );

    expect(config.servers[0]!.args).toEqual(["--token", "tok_123"]);
    expect(config.servers[0]!.env).toEqual({ OAUTH_CLIENT_SECRET: "cs_456" });
  });

  test("absolute cwd is preserved", () => {
    const config = parseCompanionMcpConfig(
      ["servers:", "  a:", "    command: a", "    cwd: /elsewhere"].join("\n"),
      COMPANION,
    );

    expect(config.servers[0]!.cwd).toBe(path.resolve("/elsewhere"));
  });

  test("empty and absent servers sections are valid empty configs", () => {
    expect(parseCompanionMcpConfig("", COMPANION)).toEqual({ servers: [], issues: [] });
    expect(parseCompanionMcpConfig("servers: {}", COMPANION)).toEqual({ servers: [], issues: [] });
  });

  test("skips invalid entries with issues while keeping valid ones", () => {
    const config = parseCompanionMcpConfig(
      [
        "servers:",
        "  good:",
        "    command: good-mcp",
        "  no-command:",
        "    args: []",
        "  bad-args:",
        "    command: x",
        "    args: [1, 2]",
        "  bad-env:",
        "    command: x",
        "    env:",
        "      KEY: 42",
        "  bad-isolation:",
        "    command: x",
        "    isolation: private",
        "  bad name!:",
        "    command: x",
        "  scalar: 5",
      ].join("\n"),
      COMPANION,
    );

    expect(config.servers.map((server) => server.name)).toEqual(["good"]);
    expect(config.issues.map((issue) => issue.server)).toEqual([
      "no-command",
      "bad-args",
      "bad-env",
      "bad-isolation",
      "bad name!",
      "scalar",
    ]);
  });

  test("invalid YAML and non-mapping roots report a config-level issue", () => {
    expect(parseCompanionMcpConfig("servers: [:::", COMPANION).issues).toHaveLength(1);
    expect(parseCompanionMcpConfig("- list", COMPANION).issues).toHaveLength(1);
    expect(parseCompanionMcpConfig("servers: nope", COMPANION).issues).toHaveLength(1);
  });
});

describe("loadCompanionMcpConfig", () => {
  test("reads <companion>/.mate/mcp.yaml", async () => {
    const companion = await makeTempDir("mcp-config-");
    await fs.mkdir(path.join(companion, ".mate"), { recursive: true });
    await fs.writeFile(
      companionMcpConfigPath(companion),
      ["servers:", "  docs:", "    command: docs-mcp"].join("\n"),
      "utf8",
    );

    const config = await loadCompanionMcpConfig(companion);

    expect(config.servers.map((server) => server.name)).toEqual(["docs"]);
    expect(config.servers[0]!.cwd).toBe(companion);
  });

  test("missing file is an empty config", async () => {
    const companion = await makeTempDir("mcp-config-missing-");

    expect(await loadCompanionMcpConfig(companion)).toEqual({ servers: [], issues: [] });
  });
});
