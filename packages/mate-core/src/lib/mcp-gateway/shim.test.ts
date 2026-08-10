import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test } from "bun:test";

import { readGatewayState } from "./daemon";
import { GatewayRuntime } from "./gateway";
import { NULL_GATEWAY_LOGGER } from "./gateway-log";
import { gatewayPaths } from "./gateway-paths";
import { runShim } from "./shim";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup().catch(() => {})));
});

function makeRuntime(paths: ReturnType<typeof gatewayPaths>, version: string): GatewayRuntime {
  const runtime = new GatewayRuntime({
    version,
    paths,
    idleShutdownMs: Infinity,
    logger: NULL_GATEWAY_LOGGER,
    resolver: {
      async resolveConnection() {
        return { repoRoot: "/repos/acme", companionPath: "/companions/acme", servers: [] };
      },
    },
    toolSource: {
      async listTools() {
        return [];
      },
      async callTool() {
        return {};
      },
    },
  });
  cleanups.push(async () => runtime.stop());
  return runtime;
}

interface ShimHarness {
  input: PassThrough;
  output: PassThrough;
  lines: string[];
  done: Promise<void>;
  waitForLine(count: number): Promise<string>;
}

function startShim(
  paths: ReturnType<typeof gatewayPaths>,
  version: string,
  spawnDaemon: () => Promise<void>,
): ShimHarness {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  const waiters: Array<() => void> = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) lines.push(line.trim());
    }
    for (const waiter of waiters.splice(0)) waiter();
  });
  const done = runShim({
    version,
    cwd: "/repos/acme",
    paths,
    input,
    output,
    spawnDaemon,
    connectTimeoutMs: 5000,
  });
  cleanups.push(async () => {
    input.end();
    await done.catch(() => {});
  });
  return {
    input,
    output,
    lines,
    done,
    async waitForLine(count: number) {
      const start = Date.now();
      while (lines.length < count) {
        if (Date.now() - start > 5000) throw new Error("waitForLine timed out");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 25);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return lines[count - 1]!;
    },
  };
}

async function makePaths(): Promise<ReturnType<typeof gatewayPaths>> {
  const mateHome = await fs.mkdtemp(path.join(os.tmpdir(), "gwshim-"));
  cleanups.push(async () => fs.rm(mateHome, { recursive: true, force: true }));
  return gatewayPaths(mateHome);
}

describe("mate mcp shim", () => {
  test("auto-starts the daemon when absent and pipes MCP frames verbatim", async () => {
    const paths = await makePaths();
    let spawns = 0;
    const shim = startShim(paths, "1.0.0", async () => {
      spawns += 1;
      await makeRuntime(paths, "1.0.0").start();
    });

    shim.input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
    );

    const reply = JSON.parse(await shim.waitForLine(1));
    expect(reply.result.serverInfo).toEqual({ name: "mate", version: "1.0.0" });
    expect(spawns).toBe(1);
    /* no gateway control frames leak to the host */
    expect(shim.lines.every((line) => !line.startsWith('{"mate":'))).toBe(true);
  });

  test("reuses a running daemon without spawning", async () => {
    const paths = await makePaths();
    await makeRuntime(paths, "1.0.0").start();
    let spawns = 0;
    const shim = startShim(paths, "1.0.0", async () => {
      spawns += 1;
    });

    shim.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);

    const reply = JSON.parse(await shim.waitForLine(1));
    expect(reply.result).toEqual({ tools: [] });
    expect(spawns).toBe(0);
  });

  test("stale daemon version is drained and replaced by the shim's version", async () => {
    const paths = await makePaths();
    const oldRuntime = makeRuntime(paths, "1.0.0");
    await oldRuntime.start();

    const shim = startShim(paths, "2.0.0", async () => {
      await makeRuntime(paths, "2.0.0").start();
    });

    shim.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const reply = JSON.parse(await shim.waitForLine(1));
    expect(reply.result).toEqual({ tools: [] });

    /* new daemon owns the socket and state; the old one exits once idle */
    expect((await readGatewayState(paths.statePath))?.version).toBe("2.0.0");
    await oldRuntime.daemon.whenStopped;
  });

  test("shim resolves when the host closes stdin", async () => {
    const paths = await makePaths();
    await makeRuntime(paths, "1.0.0").start();
    const shim = startShim(paths, "1.0.0", async () => {});
    shim.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    await shim.waitForLine(1);

    shim.input.end();

    await shim.done;
  });

  test("fails clearly when the daemon never comes up", async () => {
    const paths = await makePaths();
    const input = new PassThrough();
    const output = new PassThrough();

    const done = runShim({
      version: "1.0.0",
      cwd: "/repos/acme",
      paths,
      input,
      output,
      spawnDaemon: async () => {},
      connectTimeoutMs: 300,
    });

    expect(done).rejects.toThrow(/did not come up/);
  });
});
