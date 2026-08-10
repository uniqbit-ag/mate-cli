import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { encodeControl } from "./frames";
import { GatewayRuntime } from "./gateway";
import { NULL_GATEWAY_LOGGER } from "./gateway-log";
import { gatewayPaths } from "./gateway-paths";
import { fetchGatewayStatus } from "./status-client";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup().catch(() => {})));
});

async function makePaths(): Promise<ReturnType<typeof gatewayPaths>> {
  const mateHome = await fs.mkdtemp(path.join(os.tmpdir(), "gwstatus-"));
  cleanups.push(async () => fs.rm(mateHome, { recursive: true, force: true }));
  return gatewayPaths(mateHome);
}

describe("fetchGatewayStatus", () => {
  test("returns null without a daemon and never creates one", async () => {
    const paths = await makePaths();

    expect(await fetchGatewayStatus(paths)).toBeNull();

    expect(fs.access(paths.socketPath)).rejects.toThrow();
  });

  test("reports connections from a live daemon", async () => {
    const paths = await makePaths();
    const runtime = new GatewayRuntime({
      version: "3.2.1",
      paths,
      idleShutdownMs: Infinity,
      logger: NULL_GATEWAY_LOGGER,
      resolver: {
        async resolveConnection(cwd) {
          return {
            repoRoot: cwd,
            companionPath: "/companions/acme",
            servers: [
              {
                name: "docs-mcp",
                command: "docs",
                args: [],
                env: {},
                cwd: "/companions/acme",
                isolation: "shared",
                enabled: true,
              },
            ],
          };
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
    await runtime.start();
    cleanups.push(async () => runtime.stop());

    const session = await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(paths.socketPath);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
    cleanups.push(async () => session.destroy());
    session.write(encodeControl({ type: "hello", version: "3.2.1", cwd: "/repos/acme" }));
    await new Promise((resolve) => session.once("data", resolve));

    const status = await fetchGatewayStatus(paths);

    expect(status?.version).toBe("3.2.1");
    expect(status?.connections).toHaveLength(1);
    expect(status?.connections[0]).toMatchObject({
      repoRoot: "/repos/acme",
      companionPath: "/companions/acme",
      servers: ["docs-mcp"],
    });
  });
});
