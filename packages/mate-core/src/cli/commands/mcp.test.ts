import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { gatewayPaths } from "../../lib/mcp-gateway/gateway-paths";
import type { GatewayStatus } from "../../lib/mcp-gateway/gateway";
import { fetchGatewayStatus } from "../../lib/mcp-gateway/status-client";
import { createGateway } from "../../lib/mcp-gateway/gateway";
import { runShim } from "../../lib/mcp-gateway/shim";
import { runMcpCommand, type McpCommandDeps } from "./mcp";

const tempRoots: string[] = [];

async function makePaths(): Promise<ReturnType<typeof gatewayPaths>> {
  const mateHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-cmd-"));
  tempRoots.push(mateHome);
  return gatewayPaths(mateHome);
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  process.exitCode = undefined;
});

function makeDeps(
  overrides: Partial<McpCommandDeps>,
  paths: ReturnType<typeof gatewayPaths>,
): McpCommandDeps {
  return {
    paths,
    version: "1.2.3",
    fetchGatewayStatus,
    runShim,
    createGateway,
    spawnDetachedDaemon: async () => {},
    ...overrides,
  };
}

function liveStatus(): GatewayStatus {
  return {
    version: "1.2.3",
    pid: 4242,
    connections: [
      {
        id: 1,
        cwd: "/repos/acme/src",
        repoRoot: "/repos/acme",
        companionPath: "/companions/acme",
        clientVersion: "1.2.3",
        servers: ["docs-mcp"],
      },
    ],
    backends: [
      {
        server: "docs-mcp",
        configHash: "abcdef0123456789",
        pid: 555,
        idleMs: 12_000,
        isolation: "shared",
        connectionId: null,
      },
    ],
    manifestCache: [
      {
        configHash: "abcdef0123456789",
        command: "docs --serve",
        toolCount: 3,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

describe("mate mcp status", () => {
  test("reports not running without starting a daemon", async () => {
    const paths = await makePaths();
    const logged: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (line: string) => void logged.push(line),
    );
    try {
      await runMcpCommand("status", [], makeDeps({}, paths));
    } finally {
      logSpy.mockRestore();
    }

    expect(logged[0]).toContain("not running");
    expect(fs.access(paths.socketPath)).rejects.toThrow();
    expect(fs.access(paths.statePath)).rejects.toThrow();
  });

  test("formats connections, backends, and manifest cache from a live status", async () => {
    const paths = await makePaths();
    const logged: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (line: string) => void logged.push(line),
    );
    try {
      await runMcpCommand(
        "status",
        [],
        makeDeps({ fetchGatewayStatus: async () => liveStatus() }, paths),
      );
    } finally {
      logSpy.mockRestore();
    }

    const output = logged.join("\n");
    expect(output).toContain("version: 1.2.3");
    expect(output).toContain("repo=/repos/acme companion=/companions/acme servers=[docs-mcp]");
    expect(output).toContain("docs-mcp pid=555 idle=12s shared");
    expect(output).toContain("abcdef012345 tools=3 command=docs --serve");
  });

  test("--json emits machine-readable status", async () => {
    const paths = await makePaths();
    const logged: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (line: string) => void logged.push(line),
    );
    try {
      await runMcpCommand(
        "status",
        ["--json"],
        makeDeps({ fetchGatewayStatus: async () => liveStatus() }, paths),
      );
    } finally {
      logSpy.mockRestore();
    }

    const parsed = JSON.parse(logged[0]!);
    expect(parsed.running).toBe(true);
    expect(parsed.connections[0].servers).toEqual(["docs-mcp"]);
  });

  test("--json reports running:false without a daemon", async () => {
    const paths = await makePaths();
    const logged: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(
      (line: string) => void logged.push(line),
    );
    try {
      await runMcpCommand("status", ["--json"], makeDeps({}, paths));
    } finally {
      logSpy.mockRestore();
    }

    expect(JSON.parse(logged[0]!)).toEqual({ running: false });
  });
});

describe("mate mcp usage", () => {
  test("unknown subcommand prints usage and sets the exit code", async () => {
    const paths = await makePaths();
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation(
      (line: string) => void errors.push(line),
    );
    try {
      await runMcpCommand("bogus", [], makeDeps({}, paths));
    } finally {
      errorSpy.mockRestore();
    }

    expect(errors[0]).toContain("mcp <shim|daemon|status>");
    expect(process.exitCode).toBe(1);
  });
});
